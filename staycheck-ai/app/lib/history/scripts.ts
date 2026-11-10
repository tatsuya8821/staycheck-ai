/**
 * 履歴の保存・削除に使うLuaスクリプト。
 *
 * Luaスクリプトは原子的に実行される(実行中に他のコマンドが割り込まない)が、
 * 途中でエラーになった場合、それまでの書き込みは取り消されない(ロールバックなし)。
 * そのため、どこで止まっても「公開済みの履歴」が壊れない順序にしている。
 *
 * 【保存(COMMIT_SCRIPT)】
 *   前半: 書き込みが失敗しうる条件をすべて検査する(削除済みの印・期限・キーの型・
 *         更新番号・対象の一致)。1つでも当てはまれば何も書き込まずに返す。
 *   後半:
 *     1. 新しい写真結果を「別キー(次の更新番号のキー)」へ書き込む(=非公開の下書き)。
 *        SET ... PXAT で書くため、この時点で期限も同時に設定される。
 *     2. 概要キーを1コマンド(SET ... PXAT)で書き換えて公開する。概要には
 *        更新番号が入っており、読み込み側は「概要の更新番号の写真結果キー」だけを読む。
 *        → 1より前・1と2の間で止まっても、読み込み側からは旧状態のまま見える。
 *     3. 古い写真結果キーを削除する(失敗しても期限で消えるだけで、整合性に影響しない)。
 *     4. インデックスへの登録・期限の延長・期限切れの整理(失敗しても再送で補修される)。
 *
 * 【削除(DELETE_SCRIPT)】
 *   1. 削除済みの印(tomb)を本来の期限と同じ時刻まで置く(この時点で読み込み側からは
 *      削除済みとして扱われ、同じrunIdへの保存も拒否される)
 *   2. インデックスから外す → 3. 写真結果を削除 → 4. 概要を削除
 *
 * 概要キーの形式(文字列): "v1\n{更新番号}\n{期限ミリ秒}\n{対象}\n{概要JSON}"
 * Lua側はJSONを解釈せず、先頭の数行だけを読む。
 *
 * ARGVの failAt は自動テスト専用の障害注入。0以外を渡すと、指定した書き込みの直後で
 * わざとエラーを起こす。APIからは常に "0" を渡す(外部から指定する手段はない)。
 */

/** テストで障害注入できる位置 */
export const COMMIT_FAIL_POINTS = {
  afterStaging: 1,
  afterPublish: 2,
  afterOldItemsDelete: 3,
  /** インデックスj番目(0始まり)の各書き込みの直後: 10 + 3j + (1:ZADD, 2:PEXPIREAT, 3:整理) */
  index: (j: number, step: 1 | 2 | 3) => 10 + 3 * j + step,
} as const;

export const DELETE_FAIL_POINTS = {
  afterTombstone: 1,
  afterItemsDelete: 2,
  afterRunDelete: 3,
  /** インデックスj番目から外した直後 */
  index: (j: number) => 10 + j + 1,
} as const;

export const COMMIT_SCRIPT = `
local failAt = tonumber(ARGV[10])
local function failpoint(n)
  if failAt == n then error('INJECTED_FAILURE_' .. n) end
end
local function typeOf(k) return redis.call('TYPE', k)['ok'] end

local now = tonumber(ARGV[3])
local expiresAt = tonumber(ARGV[4])
local deadline = tonumber(ARGV[5])

-- ===== 前半: 検査のみ(書き込みなし) =====
if redis.call('EXISTS', KEYS[2]) == 1 then return {'gone'} end
if now >= deadline then return {'expired'} end
local tr = typeOf(KEYS[1])
if tr ~= 'none' and tr ~= 'string' then return {'corrupt', 'run'} end
local tn = typeOf(KEYS[3])
if tn ~= 'none' and tn ~= 'string' then return {'corrupt', 'items'} end
for i = 5, #KEYS do
  local t = typeOf(KEYS[i])
  if t ~= 'none' and t ~= 'zset' then return {'corrupt', 'index'} end
end

local curRev = 0
if tr == 'string' then
  local env = redis.call('GET', KEYS[1])
  local rev, exp, imm = string.match(env, '^v1\\n(%d+)\\n(%d+)\\n([^\\n]*)\\n')
  if not rev then return {'corrupt', 'envelope'} end
  if imm ~= ARGV[6] then return {'mismatch'} end
  curRev = tonumber(rev)
elseif tonumber(ARGV[13]) > 0 then
  -- 画面側は保存済みを確認しているのに概要が無い(削除・退避など)。新規作成と誤認しない
  return {'gone'}
end
if curRev ~= tonumber(ARGV[2]) then return {'conflict', tostring(curRev)} end

-- ===== 後半: 書き込み =====
local newRev = curRev
if ARGV[1] == 'commit' then
  newRev = curRev + 1
  -- 1. 下書き(非公開): 次の更新番号の写真結果キー
  redis.call('SET', KEYS[3], ARGV[12], 'PXAT', ARGV[4])
  failpoint(1)
  -- 2. 公開: 概要を1コマンドで差し替える
  redis.call('SET', KEYS[1], 'v1\\n' .. newRev .. '\\n' .. ARGV[4] .. '\\n' .. ARGV[6] .. '\\n' .. ARGV[11], 'PXAT', ARGV[4])
  failpoint(2)
  -- 3. 旧写真結果の削除
  if curRev > 0 and KEYS[4] ~= KEYS[3] then redis.call('DEL', KEYS[4]) end
  failpoint(3)
elseif tr == 'none' then
  return {'empty'}
end

-- 4. インデックス(登録・期限の延長・期限切れの整理)
for i = 5, #KEYS do
  local j = i - 5
  redis.call('ZADD', KEYS[i], ARGV[9], ARGV[8])
  failpoint(10 + 3 * j + 1)
  local pttl = redis.call('PTTL', KEYS[i])
  if pttl < 0 or now + pttl < expiresAt then redis.call('PEXPIREAT', KEYS[i], ARGV[4]) end
  failpoint(10 + 3 * j + 2)
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[7])
  failpoint(10 + 3 * j + 3)
end
return {'ok', tostring(newRev)}
`;

export const DELETE_SCRIPT = `
local failAt = tonumber(ARGV[4])
local function failpoint(n)
  if failAt == n then error('INJECTED_FAILURE_' .. n) end
end
local function typeOf(k) return redis.call('TYPE', k)['ok'] end

local tr = typeOf(KEYS[1])
if tr == 'none' then
  if redis.call('EXISTS', KEYS[2]) == 1 then
    -- 以前の削除が途中で止まっていた場合: インデックスからの除去だけ仕上げる
    for i = 4, #KEYS do
      if typeOf(KEYS[i]) == 'zset' then redis.call('ZREM', KEYS[i], ARGV[1]) end
    end
    return {'gone'}
  end
  return {'notfound'}
end
if tr ~= 'string' then return {'corrupt', 'run'} end
local env = redis.call('GET', KEYS[1])
local rev, exp, imm = string.match(env, '^v1\\n(%d+)\\n(%d+)\\n([^\\n]*)\\n')
if not rev then return {'corrupt', 'envelope'} end
if imm ~= ARGV[3] then return {'mismatch'} end
if tonumber(rev) ~= tonumber(ARGV[2]) then return {'conflict', rev} end
local tt = typeOf(KEYS[2])
if tt ~= 'none' and tt ~= 'string' then return {'corrupt', 'tomb'} end
local ti = typeOf(KEYS[3])
if ti ~= 'none' and ti ~= 'string' then return {'corrupt', 'items'} end
for i = 4, #KEYS do
  local t = typeOf(KEYS[i])
  if t ~= 'none' and t ~= 'zset' then return {'corrupt', 'index'} end
end

-- 1. 削除済みの印(本来の期限まで)
redis.call('SET', KEYS[2], '1', 'PXAT', exp)
failpoint(1)
-- 2. インデックスから外す
for i = 4, #KEYS do
  redis.call('ZREM', KEYS[i], ARGV[1])
  failpoint(10 + (i - 4) + 1)
end
-- 3. 写真結果 → 4. 概要
redis.call('DEL', KEYS[3])
failpoint(2)
redis.call('DEL', KEYS[1])
failpoint(3)
return {'deleted'}
`;

/**
 * インデックス1件の補修(一覧表示時に少しずつ実行する)。
 * 期限切れの整理と、期限が付いていないインデックスへの期限設定を原子的に行う
 * (別の保存と同時に実行されても、期限を短くしてしまわないようにするため)。
 * 期限は「最も新しい履歴の作成時刻 + 保存期間」とする。
 */
export const SWEEP_INDEX_SCRIPT = `
if redis.call('TYPE', KEYS[1])['ok'] ~= 'zset' then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('PTTL', KEYS[1]) == -1 then
  local top = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
  if top[2] then
    redis.call('PEXPIREAT', KEYS[1], string.format('%.0f', tonumber(top[2]) + tonumber(ARGV[2])))
    return 2
  end
end
return 1
`;
