import { test, describe, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { HistoryStore, createHistoryRedis, indexKeysFor, type HistoryStoreDeps, type TargetLookup } from "../history/store";
import { COMMIT_FAIL_POINTS, DELETE_FAIL_POINTS } from "../history/scripts";
import { aggregateItems } from "../history/merge";
import { HistoryError } from "../history/errors";
import { issueRunId, runTimes } from "../history/runId";
import type { HistoryItem, HistoryTarget } from "../history/types";

/**
 * 履歴ストアの結合テスト(本物のRedis 7 + Upstash REST互換の接続)。
 *
 * 実行方法: npm run test:integration
 *   HISTORY_IT_REDIS_URL / HISTORY_IT_REDIS_TOKEN が未設定ならすべてスキップする。
 *   localhost 以外へ接続する場合は HISTORY_IT_ALLOW_REMOTE=1 の明示が必要。
 *   接続先は検証専用のDBを推奨する(本番DBでは実行しないこと)。
 *
 * 【テストデータの片付け(v0.4.1〜)】
 *   各テストは、そのテストで作成した履歴ID・キーだけを記録し、テストが途中で失敗しても
 *   finally で削除する。接頭辞による一括削除は行わない。会社IDは実行ごとに一意な
 *   架空ID(it-co-xxxxxxxx 等)を使うため、既存の会社・物件・履歴には触れない。
 *   削除に失敗した場合は警告を表示し、そのテストを失敗扱いにする。
 *   ※ 一覧取得(listRuns)を呼ぶテストでは、アプリが履歴画面を開いたときと同じ
 *     「期限切れインデックスの整理」が動く(アプリ本来の処理であり、テスト独自の削除ではない)。
 *
 * 実在する会社名・物件名・写真は使わず、架空のIDとダミーデータのみを使う。
 *
 * 【時計のずれへの対応(v0.4.1〜、テストコード内のみ)】
 *   期限(PXAT)はアプリ側(=テストを実行するPC)の時計で決まり、実際の削除はRedis側の時計で
 *   行われる。PCの時計がずれていると、保存期間を数秒に縮めたテストだけが誤って失敗するため、
 *   最初にRedisの TIME でずれを測り、期限切れを確かめるテストでは「Redis側の時刻が期限を
 *   過ぎるまで」実際に待ってから、データが本当に消えていることを確認する。
 *   - Redisの時刻を取得できない場合は、成功扱いにせずエラーで止める。
 *   - ずれが5分を超える場合も止める(本番の「期限10分前から保存を止める」余裕の前提を超えるため)。
 *   - アプリ本体のコードは変更していない(本番は180日・余裕10分のため数秒のずれは影響しない)。
 *
 *   検証用: HISTORY_IT_SIMULATE_CLOCK_OFFSET_MS=3000 のように指定すると、テスト側の時計を
 *   わざとずらした状態(PCの時計が進んでいる/遅れている状態)を再現できる。
 */

const URL_ = process.env.HISTORY_IT_REDIS_URL;
const TOKEN = process.env.HISTORY_IT_REDIS_TOKEN;
const isLocal = URL_ ? /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URL_) : false;

/** スキップする理由(足りない設定)を具体的に示す */
function skipReason(): string | false {
  const missing: string[] = [];
  if (!URL_) missing.push("HISTORY_IT_REDIS_URL");
  if (!TOKEN) missing.push("HISTORY_IT_REDIS_TOKEN");
  if (missing.length > 0) return `未設定のためスキップ: ${missing.join(" / ")}`;
  if (!isLocal && process.env.HISTORY_IT_ALLOW_REMOTE !== "1") {
    return "localhost以外への接続には HISTORY_IT_ALLOW_REMOTE=1 が必要なためスキップ";
  }
  return false;
}
const SKIP = skipReason();
const SECRET = "integration-test-secret";

let redis: Redis;

// ===== 時計(テスト専用) =====
const SIMULATED_OFFSET_MS = Number(process.env.HISTORY_IT_SIMULATE_CLOCK_OFFSET_MS ?? 0);
if (!Number.isFinite(SIMULATED_OFFSET_MS)) throw new Error("HISTORY_IT_SIMULATE_CLOCK_OFFSET_MS は数値で指定してください");
/** テスト側(=アプリ側)の時計。ストアにもこの時計を渡す */
const clientNow = () => Date.now() + SIMULATED_OFFSET_MS;
/** Redis時刻 − テスト側時刻(ミリ秒)。before() で測定する */
let clockSkewMs = 0;
const MAX_ALLOWED_SKEW_MS = 5 * 60 * 1000;

/** Redisの TIME からサーバー時刻(ミリ秒)を取得する。失敗した場合は原因が分かるエラーを投げる */
async function redisServerTimeMs(client: Redis = redis): Promise<number> {
  let raw: unknown;
  try {
    raw = await client.time();
  } catch (e) {
    throw new Error(`Redis(Upstash)側の時刻を取得できませんでした(TIMEコマンドが失敗): ${e instanceof Error ? e.message : String(e)}`);
  }
  const [sec, usec] = Array.isArray(raw) ? raw.map(Number) : [NaN, NaN];
  if (!Number.isFinite(sec) || !Number.isFinite(usec) || sec <= 0) {
    throw new Error(`Redis(Upstash)側の時刻を取得できませんでした(想定外の応答: ${JSON.stringify(raw)})`);
  }
  return sec * 1000 + Math.floor(usec / 1000);
}

/** 時計のずれを測る(往復時間の半分を誤差として扱い、3回測って往復が最短のものを採用) */
async function measureClockSkew(): Promise<{ skewMs: number; rttMs: number }> {
  let best: { skewMs: number; rttMs: number } | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = clientNow();
    const server = await redisServerTimeMs();
    const t1 = clientNow();
    const sample = { skewMs: Math.round(server - (t0 + t1) / 2), rttMs: t1 - t0 };
    if (!best || sample.rttMs < best.rttMs) best = sample;
  }
  return best!;
}

/**
 * Redis側の時刻が target を過ぎ、かつテスト側の時刻が clientTarget を過ぎるまで待つ。
 * (推定値ではなく実際のRedis時刻で判定する。最大 maxWaitMs で打ち切り、エラーにする)
 */
async function waitUntil(target: { serverMs: number; clientMs: number }, maxWaitMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const server = await redisServerTimeMs();
    if (server >= target.serverMs && clientNow() >= target.clientMs) return;
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`待機がタイムアウトしました(Redis時刻 ${server} / 目標 ${target.serverMs}、テスト側時刻 ${clientNow()} / 目標 ${target.clientMs})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const lookup: TargetLookup = async (t) => {
  if (t.mode === "standard") return {};
  if (t.companyId === "deleted-co") return null;
  return {
    companyLabel: "テスト会社",
    ...(t.propertyId
      ? { propertyLabel: "テスト物件", ruleFingerprint: { propertyUpdatedAt: "2026-01-01T00:00:00.000Z", ruleTextSha256: "abcdef012345" } }
      : {}),
  };
};

// ===== テストデータの記録と片付け =====
interface Tracker {
  runIds: Set<string>;
  keys: Set<string>;
  members: { key: string; member: string }[];
}
const newTracker = (): Tracker => ({ runIds: new Set(), keys: new Set(), members: [] });
/** 実行中のテストが作成したもの */
let tracker: Tracker = newTracker();
/** このテストで使う可能性のあるインデックス(既存データを消すのではなく、記録した履歴IDだけをZREMする) */
const candidateIndexKeys = () => [
  "history:idx:all",
  `history:idx:co:${CO}`,
  `history:idx:co:${OTHER_CO}`,
  `history:idx:co:${SWEEP_CO}`,
  `history:idx:prop:${CO}:room-1`,
];

function makeStore(extra: Partial<HistoryStoreDeps> = {}) {
  const store = new HistoryStore({ redis, secret: SECRET, lookupTarget: lookup, now: clientNow, ...extra });
  // 発行した履歴IDを必ず記録する(片付けの対象はここで記録したIDだけ)
  const issue = store.issueRun.bind(store);
  store.issueRun = async (target) => {
    const r = await issue(target);
    tracker.runIds.add(r.runId);
    return r;
  };
  return store;
}

/** 指定した履歴IDの写真結果キー(履歴IDを完全に指定した読み取り専用の検索) */
async function itemKeysOf(runId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(cursor, { match: `history:items:${runId}:r*`, count: 1000 });
    out.push(...(found as string[]));
    cursor = String(next);
  } while (cursor !== "0");
  return out;
}

/** 指定した履歴IDのデータ(概要・削除済みの印・写真結果)がいくつ残っているか */
async function runKeysExist(runId: string): Promise<number> {
  return (await redis.exists(`history:run:${runId}`, `history:tomb:${runId}`)) + (await itemKeysOf(runId)).length;
}

/** 記録した履歴ID・キーだけを削除し、消えたことを確認する。問題があれば内容を返す */
async function cleanupTracked(t: Tracker): Promise<string[]> {
  const problems: string[] = [];
  for (const runId of t.runIds) {
    try {
      // 概要が文字列のときだけ更新番号を読む(型を壊したテストのキーでも片付けられるように)
      const runType = await redis.type(`history:run:${runId}`);
      const raw = runType === "string" ? await redis.get<string>(`history:run:${runId}`) : null;
      const rev = raw ? Number(/^v1\n(\d+)\n/.exec(String(raw))?.[1] ?? 0) : 0;
      // 写真結果キーは履歴IDと更新番号を完全に指定して削除する(下書きを含め多めに指定)
      const itemKeys = Array.from({ length: Math.max(rev, 0) + 40 }, (_, i) => `history:items:${runId}:r${i}`);
      await redis.del(`history:run:${runId}`, `history:tomb:${runId}`, ...itemKeys);
      for (const idx of candidateIndexKeys()) await redis.zrem(idx, runId);
      const left = await runKeysExist(runId);
      if (left > 0) problems.push(`履歴 ${runId} のキーが ${left} 件残っています`);
      for (const idx of candidateIndexKeys()) {
        if ((await redis.zscore(idx, runId)) !== null) problems.push(`履歴 ${runId} が ${idx} に残っています`);
      }
    } catch (e) {
      problems.push(`履歴 ${runId} の削除中にエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const key of t.keys) {
    try {
      await redis.del(key);
      if ((await redis.exists(key)) > 0) problems.push(`キー ${key} が残っています`);
    } catch (e) {
      problems.push(`キー ${key} の削除中にエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const { key, member } of t.members) {
    try {
      await redis.zrem(key, member);
      if ((await redis.zscore(key, member)) !== null) problems.push(`${key} の ${member} が残っています`);
    } catch (e) {
      problems.push(`${key} の ${member} の削除中にエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/**
 * テストを実行し、成否にかかわらず finally で片付ける。
 * 片付けに失敗した場合は警告を表示し、テスト自体が成功していても失敗扱いにする。
 */
function itest(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, async (t) => {
    tracker = newTracker();
    let testError: unknown = null;
    try {
      await fn(t);
    } catch (e) {
      testError = e;
    } finally {
      const problems = await cleanupTracked(tracker);
      if (problems.length > 0) {
        console.warn(`  [片付け警告] ${name}: ${problems.join(" / ")}`);
        if (!testError) testError = new Error(`テストデータの片付けに失敗しました: ${problems.join(" / ")}`);
      }
    }
    if (testError) throw testError;
  });
}

/**
 * 共有インデックス(history:idx:all)に、このテストで作ったもの以外の履歴が無いか。
 * 保存期間を数秒に縮めた保存は、アプリの仕様どおり「その保存期間より古いインデックス項目」を
 * 整理するため、他の履歴が入ったDBで実行すると、それらを全体一覧から外してしまう。
 * そのテストは、他の履歴が無い(検証専用の空の)DBでだけ実行する。
 */
async function sharedIndexIsIsolated(): Promise<{ ok: boolean; others: number }> {
  const members = (await redis.zrange("history:idx:all", 0, -1)) as string[];
  const others = members.filter((m) => !tracker.runIds.has(m)).length;
  return { ok: others === 0, others };
}

/** 一覧に、このテストで作った履歴がいくつ表示されるか(他の履歴は数えない) */
async function countListed(store: HistoryStore, filter: Parameters<HistoryStore["listRuns"]>[0] = {}) {
  const { runs } = await store.listRuns({ limit: 50, ...filter });
  return runs.filter((r) => tracker.runIds.has(r.runId)).length;
}

/** この実行だけで使う一意な架空ID(既存の会社・物件と衝突しない) */
const RUN_TAG = randomUUID().replace(/-/g, "").slice(0, 8);
const CO = `it-co-${RUN_TAG}`;
const OTHER_CO = `it-other-${RUN_TAG}`;
const SWEEP_CO = `it-sweep-${RUN_TAG}`;
const PROPERTY: HistoryTarget = { mode: "property", companyId: CO, propertyId: "room-1" };
const STANDARD: HistoryTarget = { mode: "standard" };
const JUDGMENTS = ["◎ 良好", "○ 基準内", "◇ 確認推奨", "△ 要調整"] as const;

function doneItem(photoKey: string, gen: number, i = 0): HistoryItem {
  return {
    photoKey,
    gen,
    fileName: `dummy-${i}.jpg`,
    source: "local",
    category: "auto",
    propertyName: "サンプル物件101",
    status: "done",
    judgment: JUDGMENTS[(i + gen) % 4],
    summary: `ダミー要約 ${i} 世代${gen}`,
    checks: [{ label: "ダミー項目", ok: true }],
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedTokens: 200 },
    judgedAt: new Date(1_790_000_000_000 + gen * 1000 + i).toISOString(),
  };
}
function errorItem(photoKey: string, gen: number, i = 0): HistoryItem {
  return {
    photoKey,
    gen,
    fileName: `dummy-${i}.jpg`,
    source: "drive",
    category: "auto",
    propertyName: "",
    status: "error",
    errorCode: "rate_limited",
    judgedAt: new Date(1_790_000_000_000 + gen * 1000 + i).toISOString(),
  };
}

/** 履歴の整合性: 概要の集計 = 写真結果から計算した値、概要と写真結果の期限が一致 */
async function assertConsistent(store: HistoryStore, runId: string) {
  const d = await store.getRun(runId);
  assert.ok(d, "履歴が読めること");
  const agg = aggregateItems(d!.items);
  assert.equal(d!.run.photoCount, agg.photoCount);
  assert.deepEqual(d!.run.counts, agg.counts);
  assert.equal(d!.run.errorCount, agg.errorCount);
  assert.equal(d!.run.costUsd, agg.costUsd);
  const runTtl = await redis.pttl(`history:run:${runId}`);
  const itemsTtl = await redis.pttl(`history:items:${runId}:r${d!.run.rev}`);
  assert.ok(runTtl > 0 && itemsTtl > 0, "概要・写真結果に期限が付いていること");
  assert.ok(Math.abs(runTtl - itemsTtl) < 1000, "概要と写真結果の期限が一致すること");
  return d!;
}

/** このテストで作った履歴のキーと、関係するインデックスすべてに期限が付いていること */
async function assertAllKeysHaveTtl() {
  const keys: string[] = [];
  for (const runId of tracker.runIds) {
    keys.push(`history:run:${runId}`, `history:tomb:${runId}`, ...(await itemKeysOf(runId)));
  }
  keys.push(...candidateIndexKeys());
  for (const k of keys) {
    if ((await redis.exists(k)) === 0) continue;
    const ttl = await redis.pttl(k);
    assert.ok(ttl > 0, `期限が付いていないキー: ${k} (pttl=${ttl})`);
  }
}

async function seed(store: HistoryStore, target: HistoryTarget, items: HistoryItem[]) {
  const { runId } = await store.issueRun(target);
  const r = await store.saveRun(runId, { target, baseRev: 0, items });
  assert.equal(r.rev, 1);
  return runId;
}

describe("履歴ストア結合テスト(Redis 7)", { skip: SKIP }, () => {
  before(async () => {
    redis = createHistoryRedis(URL_!, TOKEN!);
    const pong = await redis.ping();
    assert.equal(pong, "PONG");
    // 時刻を取得できなければここで例外 → 全テストが失敗扱いになる(成功扱いにはしない)
    const { skewMs, rttMs } = await measureClockSkew();
    clockSkewMs = skewMs;
    console.log(
      `  [時計] Redis時刻 − テスト側時刻 = ${skewMs >= 0 ? "+" : ""}${skewMs}ms(往復 ${rttMs}ms` +
        `${SIMULATED_OFFSET_MS ? `、テスト側を ${SIMULATED_OFFSET_MS}ms ずらして実行` : ""})`
    );
    if (Math.abs(skewMs) > MAX_ALLOWED_SKEW_MS) {
      throw new Error(
        `PCとRedis(Upstash)の時計が ${Math.round(skewMs / 1000)} 秒ずれています(上限5分)。` +
          "Windowsの「設定 → 時刻と言語 → 日付と時刻 → 今すぐ同期」で時刻を合わせてから再実行してください。"
      );
    }
  });

  itest("片付け: このテストで記録した履歴だけが削除され、記録していない履歴は残る", async () => {
    const store = makeStore();
    const items = [doneItem(randomUUID(), 1)];
    const mine = await seed(store, STANDARD, items);
    // 記録しない(=既存データに見立てた)履歴を別に作る
    const untracked = new HistoryStore({ redis, secret: SECRET, lookupTarget: lookup, now: clientNow });
    const { runId: other } = await untracked.issueRun(STANDARD);
    await untracked.saveRun(other, { target: STANDARD, baseRev: 0, items });
    try {
      const sub: Tracker = { runIds: new Set([mine]), keys: new Set(), members: [] };
      assert.deepEqual(await cleanupTracked(sub), [], "片付けで問題が起きない");
      assert.equal(await runKeysExist(mine), 0, "記録した履歴は消える");
      assert.equal(await redis.zscore("history:idx:all", mine), null);
      assert.equal(await redis.exists(`history:run:${other}`), 1, "記録していない履歴は残る");
      assert.notEqual(await redis.zscore("history:idx:all", other), null, "記録していない履歴のインデックスも残る");
    } finally {
      // 検証用に作った「記録していない履歴」も、このテストの最後に片付ける
      tracker.runIds.add(other);
    }
  });

  itest("前提確認: Redis側の時刻を取得できない場合は、原因が分かるエラーになる(成功扱いにしない)", async () => {
    const broken = createHistoryRedis(URL_!, "wrong-token-for-test");
    await assert.rejects(redisServerTimeMs(broken), /Redis\(Upstash\)側の時刻を取得できませんでした/);
  });

  itest("前提確認: Redisのスクリプトは途中エラー時に書き込みを取り消さない", async () => {
    const key = `history:it-premise:${RUN_TAG}`;
    tracker.keys.add(key);
    await assert.rejects(redis.eval("redis.call('SET', KEYS[1], 'x', 'PX', 60000); error('boom')", [key], []));
    assert.equal(await redis.get(key), "x", "途中までの書き込みが残る(=ロールバックされない)");
  });

  itest("新規作成 → 読み込み・一覧・期限", async () => {
    const store = makeStore();
    const keys = Array.from({ length: 4 }, () => randomUUID());
    const runId = await seed(store, PROPERTY, keys.map((k, i) => doneItem(k, 1, i)));
    const d = await assertConsistent(store, runId);
    assert.equal(d.run.photoCount, 4);
    assert.equal(d.run.companyLabel, "テスト会社");
    assert.equal(d.run.propertyLabel, "テスト物件");
    for (const idx of indexKeysFor(PROPERTY)) {
      assert.equal(Number(await redis.zscore(idx, runId)), parseInt(runId.split(".")[0], 36));
    }
    assert.equal(await countListed(store, { companyId: CO, propertyId: "room-1" }), 1);
    assert.equal((await store.listRuns({ companyId: OTHER_CO })).runs.length, 0);
    // 残り期限(Redis側) + ずれ ≒ 180日。測定誤差として前後5秒まで許容する
    const pttl = await redis.pttl(`history:run:${runId}`);
    const expectedPttl = parseInt(runId.split(".")[0], 36) + 180 * 86_400_000 - (clientNow() + clockSkewMs);
    assert.ok(Math.abs(pttl - expectedPttl) < 5000, `期限が「作成時刻+180日」であること(実測 ${pttl} / 期待 ${expectedPttl})`);
    const ttlDays = (pttl + clockSkewMs) / 86_400_000;
    assert.ok(ttlDays > 179.9 && ttlDays <= 180.001, `期限が約180日であること(${ttlDays})`);
    await assertAllKeysHaveTtl();
  });

  itest("再判定: 対象の写真だけ更新され、他の写真結果は1バイトも変わらない", async () => {
    const store = makeStore();
    const keys = Array.from({ length: 10 }, () => randomUUID());
    const items = keys.map((k, i) => (i < 2 ? errorItem(k, 1, i) : doneItem(k, 1, i)));
    const runId = await seed(store, STANDARD, items);
    const before = await store.getRun(runId);

    const r = await store.saveRun(runId, { target: STANDARD, baseRev: 1, items: [doneItem(keys[0], 2, 0), doneItem(keys[1], 2, 1)] });
    assert.equal(r.status, "saved");
    assert.equal(r.rev, 2);
    const after = await assertConsistent(store, runId);
    for (let i = 2; i < 10; i++) {
      assert.equal(JSON.stringify(after.items[i]), JSON.stringify(before!.items[i]), `写真${i}は不変`);
    }
    assert.equal(after.items[0].gen, 2);
    assert.equal(after.run.errorCount, 0);
    assert.equal(await redis.exists(`history:items:${runId}:r1`), 0, "旧写真結果キーは削除される");
    assert.equal(after.run.createdAt, before!.run.createdAt, "作成日時は変わらない");
  });

  itest("同じ内容の再送(3回)では更新番号が増えない", async () => {
    const store = makeStore();
    const items = [doneItem(randomUUID(), 1, 0), errorItem(randomUUID(), 1, 1)];
    const runId = await seed(store, STANDARD, items);
    for (let i = 0; i < 3; i++) {
      const r = await store.saveRun(runId, { target: STANDARD, baseRev: 1, items });
      assert.equal(r.status, "unchanged");
      assert.equal(r.rev, 1);
    }
    const d = await assertConsistent(store, runId);
    assert.equal(d.run.rev, 1);
    assert.equal(await countListed(store), 1, "一覧に重複しない");
  });

  itest("古い世代の保存は新しい再判定結果を上書きしない", async () => {
    const store = makeStore();
    const k = randomUUID();
    const runId = await seed(store, STANDARD, [errorItem(k, 1)]);
    await store.saveRun(runId, { target: STANDARD, baseRev: 1, items: [doneItem(k, 3)] });
    // 遅れて届いた世代2(古い)の保存
    const stale = await store.saveRun(runId, { target: STANDARD, baseRev: 1, items: [doneItem(k, 2)] });
    assert.equal(stale.status, "unchanged");
    assert.equal(stale.rev, 2);
    assert.equal(stale.staleIgnored, 1);
    const d = await assertConsistent(store, runId);
    assert.equal(d.items[0].gen, 3);
    assert.equal(d.items[0].summary, doneItem(k, 3).summary);
    // 古い写真+新しい写真の混在: 新しい写真だけが追加され、古い写真は無視される
    const k2 = randomUUID();
    const mixed = await store.saveRun(runId, { target: STANDARD, baseRev: 2, items: [errorItem(k, 1), doneItem(k2, 1, 5)] });
    assert.equal(mixed.rev, 3);
    assert.equal(mixed.staleIgnored, 1);
    const d2 = await assertConsistent(store, runId);
    assert.equal(d2.items.length, 2);
    assert.equal(d2.items[0].gen, 3);
  });

  itest("同じ世代で内容が異なる保存は既存を優先する(conflictとして数える)", async () => {
    const store = makeStore();
    const k = randomUUID();
    const runId = await seed(store, STANDARD, [doneItem(k, 1)]);
    const tampered = { ...doneItem(k, 1), summary: "別の内容" };
    const r = await store.saveRun(runId, { target: STANDARD, baseRev: 1, items: [tampered] });
    assert.equal(r.status, "unchanged");
    assert.equal(r.conflicts, 1);
    assert.equal((await store.getRun(runId))!.items[0].summary, doneItem(k, 1).summary);
  });

  describe("保存スクリプトの途中で意図的にエラーを起こす(既存の履歴)", () => {
    const idxCount = indexKeysFor(PROPERTY).length; // 3
    const points: { name: string; at: number; published: boolean }[] = [
      { name: "下書き書き込み直後", at: COMMIT_FAIL_POINTS.afterStaging, published: false },
      { name: "公開直後", at: COMMIT_FAIL_POINTS.afterPublish, published: true },
      { name: "旧写真結果の削除直後", at: COMMIT_FAIL_POINTS.afterOldItemsDelete, published: true },
    ];
    for (let j = 0; j < idxCount; j++) {
      for (const step of [1, 2, 3] as const) {
        points.push({ name: `インデックス${j}の書き込み${step}直後`, at: COMMIT_FAIL_POINTS.index(j, step), published: true });
      }
    }
    for (const p of points) {
      itest(`${p.name}(failAt=${p.at})`, async () => {
        const store = makeStore();
        const keys = Array.from({ length: 5 }, () => randomUUID());
        const runId = await seed(store, PROPERTY, keys.map((k, i) => (i < 2 ? errorItem(k, 1, i) : doneItem(k, 1, i))));
        const before = await store.getRun(runId);
        const update = [doneItem(keys[0], 2, 0), doneItem(keys[1], 2, 1)];

        const faulty = makeStore({ failAt: { commit: p.at } });
        await assert.rejects(faulty.saveRun(runId, { target: PROPERTY, baseRev: 1, items: update }), /INJECTED_FAILURE/);

        // 読み込み側からは「完全な旧状態」か「完全な新状態」のどちらかに見える
        const mid = await assertConsistent(store, runId);
        if (p.published) {
          assert.equal(mid.run.rev, 2);
          assert.equal(mid.items[0].gen, 2);
          assert.equal(mid.run.errorCount, 0);
        } else {
          assert.deepEqual(mid, before, "公開前の失敗では旧状態が完全に保たれる");
          const staging = await redis.pttl(`history:items:${runId}:r2`);
          assert.ok(staging > 0, "未公開の下書きにも期限が付いている");
        }
        for (let i = 2; i < 5; i++) assert.equal(JSON.stringify(mid.items[i]), JSON.stringify(before!.items[i]));

        // 同じ内容を再送 → 正しい最終状態。公開済みなら更新番号は増えない
        const retry = await store.saveRun(runId, { target: PROPERTY, baseRev: p.published ? 2 : 1, items: update });
        assert.equal(retry.rev, 2);
        assert.equal(retry.status, p.published ? "unchanged" : "saved");
        const final = await assertConsistent(store, runId);
        assert.equal(final.items[0].gen, 2);
        for (const idx of indexKeysFor(PROPERTY)) {
          assert.ok((await redis.zscore(idx, runId)) !== null, `インデックス ${idx} に登録されている`);
        }
        assert.equal(await countListed(store), 1);
        await assertAllKeysHaveTtl();
      });
    }
  });

  describe("保存スクリプトの途中で意図的にエラーを起こす(新規作成)", () => {
    for (const at of [COMMIT_FAIL_POINTS.afterStaging, COMMIT_FAIL_POINTS.afterPublish, COMMIT_FAIL_POINTS.index(0, 1), COMMIT_FAIL_POINTS.index(1, 1)]) {
      itest(`failAt=${at}`, async () => {
        const store = makeStore();
        const { runId } = await store.issueRun(PROPERTY);
        const items = [doneItem(randomUUID(), 1, 0)];
        await assert.rejects(makeStore({ failAt: { commit: at } }).saveRun(runId, { target: PROPERTY, baseRev: 0, items }), /INJECTED_FAILURE/);
        const mid = await store.getRun(runId);
        if (at === COMMIT_FAIL_POINTS.afterStaging) {
          assert.equal(mid, null, "公開前なら履歴は存在しないまま");
          assert.equal(await countListed(store), 0);
        } else {
          await assertConsistent(store, runId);
        }
        const r = await store.saveRun(runId, { target: PROPERTY, baseRev: mid ? 1 : 0, items });
        assert.equal(r.rev, 1, "再送しても重複作成されず、更新番号は1のまま");
        assert.equal(await countListed(store), 1);
        await assertAllKeysHaveTtl();
      });
    }

    itest("インデックス登録直後(期限設定前)に止まり、再送されなくても一覧表示時の補修で期限が付く", async () => {
      // この実行専用の会社IDを使い、新しく作られるインデックス(会社別)で確認する
      const target: HistoryTarget = { mode: "company", companyId: SWEEP_CO };
      const idxKey = `history:idx:co:${SWEEP_CO}`;
      const store = makeStore();
      const { runId } = await store.issueRun(target);
      await assert.rejects(
        makeStore({ failAt: { commit: COMMIT_FAIL_POINTS.index(1, 1) } }).saveRun(runId, { target, baseRev: 0, items: [doneItem(randomUUID(), 1)] }),
        /INJECTED_FAILURE/
      );
      assert.equal(await redis.pttl(idxKey), -1, "この時点では期限なし");
      // 補修は一覧表示のたびに少しずつ進むため、期限が付くまで一覧表示を繰り返す(最大30回)
      for (let i = 0; i < 30 && (await redis.pttl(idxKey)) < 0; i++) await store.listRuns();
      assert.ok((await redis.pttl(idxKey)) > 0, "補修で期限が付く");
      await assertAllKeysHaveTtl();
    });
  });

  describe("削除スクリプトの途中で意図的にエラーを起こす", () => {
    const points = [
      DELETE_FAIL_POINTS.afterTombstone,
      DELETE_FAIL_POINTS.index(0),
      DELETE_FAIL_POINTS.index(1),
      DELETE_FAIL_POINTS.index(2),
      DELETE_FAIL_POINTS.afterItemsDelete,
      DELETE_FAIL_POINTS.afterRunDelete,
    ];
    for (const at of points) {
      itest(`failAt=${at}`, async () => {
        const store = makeStore();
        const items = [doneItem(randomUUID(), 1)];
        const runId = await seed(store, PROPERTY, items);
        await assert.rejects(makeStore({ failAt: { delete: at } }).deleteRun(runId), /INJECTED_FAILURE/);
        // 削除済みの印が先に置かれるため、どこで止まっても削除済みとして扱われる
        assert.equal(await store.getRun(runId), null);
        assert.equal(await countListed(store), 0);
        await assert.rejects(store.saveRun(runId, { target: PROPERTY, baseRev: 1, items }), (e: HistoryError) => e.code === "gone");
        // 削除をやり直すと完了する
        const again = await store.deleteRun(runId);
        assert.ok(again === "deleted" || again === "already_deleted");
        for (const idx of indexKeysFor(PROPERTY)) assert.equal(await redis.zscore(idx, runId), null);
        assert.equal(await redis.exists(`history:run:${runId}`, `history:items:${runId}:r1`), 0);
        assert.ok((await redis.pttl(`history:tomb:${runId}`)) > 0, "削除済みの印には期限がある");
        await assertAllKeysHaveTtl();
      });
    }
  });

  itest("同じ履歴への同時保存(10件並列)でも写真結果が失われない", async () => {
    const store = makeStore({ maxAttempts: 30 });
    const base = Array.from({ length: 3 }, (_, i) => doneItem(randomUUID(), 1, i));
    const runId = await seed(store, STANDARD, base);
    const extra = Array.from({ length: 10 }, (_, i) => doneItem(randomUUID(), 1, i + 3));
    const results = await Promise.all(extra.map((it) => store.saveRun(runId, { target: STANDARD, baseRev: 1, items: [it] })));
    assert.ok(results.every((r) => r.status === "saved"));
    const d = await assertConsistent(store, runId);
    assert.equal(d.items.length, 13);
    assert.equal(d.run.rev, 11, "変更10回 → 更新番号はちょうど10増える");
    // 同じ内容の並列再送では更新番号が増えない
    await Promise.all(extra.map((it) => store.saveRun(runId, { target: STANDARD, baseRev: 11, items: [it] })));
    assert.equal((await store.getRun(runId))!.run.rev, 11);
  });

  itest("復活防止: 期限切れで消えたrunIdへの保存は拒否され、キーも作られない(期限による実削除の確認)", async (tc) => {
    const iso = await sharedIndexIsIsolated();
    if (!iso.ok) {
      const msg =
        `他の履歴が ${iso.others} 件あるDBのためスキップ(このテストは保存期間を数秒に縮めて保存するため、` +
        "他の履歴を全体一覧から外してしまう)。期限による実削除は、空の検証専用DBで確認してください。";
      console.warn(`  [スキップ] ${msg}`);
      tc.skip(msg);
      return;
    }
    // Redis側の時計が進んでいる場合、保存期間が短すぎると保存した瞬間に期限切れになるため、ずれの分だけ延ばす
    const retentionMs = 2500 + Math.max(0, clockSkewMs);
    const store = makeStore({ retentionMs, writeMarginMs: 300 });
    const items = [doneItem(randomUUID(), 1)];
    const runId = await seed(store, STANDARD, items);
    // 保存直後は確かに存在する(=この後に消えるのは期限によるもの)
    assert.equal(await redis.exists(`history:run:${runId}`, `history:items:${runId}:r1`), 2, "保存直後は存在する");
    assert.ok((await redis.pttl(`history:run:${runId}`)) > 0, "期限が付いている");
    const t = runTimes(runId, retentionMs, 300);
    // 実際のRedis時刻が期限を過ぎ、かつアプリ側の時刻が保存締切を過ぎるまで待つ(推定ではなく実測)
    // 待ち時間の上限: 保存期間 + 時計のずれ + 余裕20秒(PCの時計が進んでいる場合、Redis側の期限到来はずれの分だけ遅れる)
    await waitUntil({ serverMs: t.expiresAtMs + 200, clientMs: t.writeDeadlineMs + 200 }, retentionMs + Math.abs(clockSkewMs) + 20_000);
    assert.equal(await redis.exists(`history:run:${runId}`, `history:items:${runId}:r1`), 0, "期限でデータが消えている");
    assert.equal(await redis.get(`history:run:${runId}`), null, "読み出しても値は無い");
    assert.equal(await store.getRun(runId), null, "履歴としても読めない");
    await assert.rejects(store.saveRun(runId, { target: STANDARD, baseRev: 0, items }), (e: HistoryError) => e.code === "expired");
    await assert.rejects(store.saveRun(runId, { target: STANDARD, baseRev: 1, items }), (e: HistoryError) => e.code === "expired");
    assert.equal(await redis.exists(`history:run:${runId}`, `history:items:${runId}:r1`, `history:items:${runId}:r2`), 0);
    // 一覧の確認は通常の保存期間(180日)のストアで行う(短い保存期間のまま一覧を開くと、他のインデックスも整理してしまうため)
    assert.equal(await countListed(makeStore()), 0);
  });

  itest("復活防止: 期限の10分前以降(余裕時間内)も保存を拒否する", async () => {
    const store = makeStore({ retentionMs: 5000, writeMarginMs: 4000 });
    const { runId } = await store.issueRun(STANDARD);
    await new Promise((r) => setTimeout(r, 1100));
    await assert.rejects(store.saveRun(runId, { target: STANDARD, baseRev: 0, items: [doneItem(randomUUID(), 1)] }), (e: HistoryError) => e.code === "expired");
    assert.equal(await runKeysExist(runId), 0, "キーが作られていない");
  });

  itest("復活防止: 保存済みを確認した後に概要が消えていた場合は新規作成しない", async () => {
    const store = makeStore();
    const items = [doneItem(randomUUID(), 1)];
    const runId = await seed(store, STANDARD, items);
    await redis.del(`history:run:${runId}`, `history:items:${runId}:r1`); // 退避等で消えた想定
    await assert.rejects(store.saveRun(runId, { target: STANDARD, baseRev: 1, items }), (e: HistoryError) => e.code === "gone");
    assert.equal(await redis.exists(`history:run:${runId}`), 0);
  });

  itest("復活防止: 手動削除した履歴への保存は拒否される", async () => {
    const store = makeStore();
    const items = [doneItem(randomUUID(), 1)];
    const runId = await seed(store, STANDARD, items);
    assert.equal(await store.deleteRun(runId), "deleted");
    await assert.rejects(store.saveRun(runId, { target: STANDARD, baseRev: 0, items }), (e: HistoryError) => e.code === "gone");
    assert.equal(await redis.exists(`history:run:${runId}`), 0);
  });

  itest("インデックス: 期限切れ・実体なしは表示されず整理される。期限は最新の履歴に合わせて延びる", async () => {
    const store = makeStore();
    const runId = await seed(store, PROPERTY, [doneItem(randomUUID(), 1)]);
    const oldScore = clientNow() - 181 * 86_400_000;
    const expiredMember = `it-expired-${RUN_TAG}`;
    const danglingMember = issueRunId(STANDARD, SECRET, clientNow() - 1000);
    tracker.members.push({ key: "history:idx:all", member: expiredMember }, { key: "history:idx:all", member: danglingMember });
    await redis.zadd("history:idx:all", { score: oldScore, member: expiredMember });
    await redis.zadd("history:idx:all", { score: clientNow() - 1000, member: danglingMember });
    const list = await store.listRuns({ limit: 50 });
    assert.ok(list.runs.some((r) => r.runId === runId), "このテストの履歴は表示される");
    assert.ok(!list.runs.some((r) => r.runId === expiredMember || r.runId === danglingMember), "期限切れ・実体なしは表示されない");
    for (let i = 0; i < 30 && (await redis.zscore("history:idx:all", expiredMember)) !== null; i++) await store.listRuns();
    assert.equal(await redis.zscore("history:idx:all", danglingMember), null, "実体なしはインデックスから消える");
    assert.equal(await redis.zscore("history:idx:all", expiredMember), null, "期限切れはインデックスから消える");
    const idxTtl = await redis.pttl("history:idx:all");
    const runTtl = await redis.pttl(`history:run:${runId}`);
    // 既知の制約(KI-011): アプリ側の時計がRedisより Δ 進んでいると、インデックスの期限延長の判定が
    // Δ だけ甘くなり、インデックスが最新の履歴より最大 Δ 早く期限切れになりうる(180日の終わりの数秒〜数十秒)。
    // そのため、アプリ側が進んでいる分(−ずれ)だけ許容する。
    const allowance = 1000 + Math.max(0, -clockSkewMs);
    assert.ok(idxTtl >= runTtl - allowance, `インデックスの期限 ≥ 最新の履歴の期限(差 ${runTtl - idxTtl}ms / 許容 ${allowance}ms)`);
    await redis.persist(`history:idx:co:${CO}`);
    for (let i = 0; i < 30 && (await redis.pttl(`history:idx:co:${CO}`)) < 0; i++) await store.listRuns();
    assert.ok((await redis.pttl(`history:idx:co:${CO}`)) > 0, "期限の無いインデックスは補修される");
  });

  itest("想定外のキー型があれば何も書き込まずに中止する", async () => {
    const store = makeStore();
    const { runId } = await store.issueRun(STANDARD);
    await redis.hset(`history:run:${runId}`, { x: "1" });
    await redis.pexpire(`history:run:${runId}`, 60_000);
    await assert.rejects(store.saveRun(runId, { target: STANDARD, baseRev: 0, items: [doneItem(randomUUID(), 1)] }));
    assert.equal(await redis.exists(`history:items:${runId}:r1`), 0);
    assert.equal(await redis.zscore("history:idx:all", runId), null, "インデックスにも登録されない");
  });

  itest("別の対象のrunIdには保存できない(署名の不一致)", async () => {
    const store = makeStore();
    const { runId } = await store.issueRun({ mode: "company", companyId: CO });
    await assert.rejects(
      store.saveRun(runId, { target: { mode: "company", companyId: OTHER_CO }, baseRev: 0, items: [doneItem(randomUUID(), 1)] }),
      (e: HistoryError) => e.code === "forbidden"
    );
    assert.equal(await runKeysExist(runId), 0, "キーが作られていない");
  });

  itest("会社・物件が削除されても以前の表示名は残る", async () => {
    const store = makeStore();
    const target: HistoryTarget = { mode: "company", companyId: CO };
    const runId = await seed(store, target, [doneItem(randomUUID(), 1)]);
    const deletedLookup = makeStore({ lookupTarget: async () => null });
    await deletedLookup.saveRun(runId, { target, baseRev: 1, items: [doneItem(randomUUID(), 1, 1)] });
    assert.equal((await store.getRun(runId))!.run.companyLabel, "テスト会社");
  });

  itest("300枚を1回で保存でき、301枚目は拒否される", async () => {
    const store = makeStore();
    const items = Array.from({ length: 300 }, (_, i) => doneItem(randomUUID(), 1, i));
    const bytes = Buffer.byteLength(JSON.stringify(items));
    const t0 = Date.now();
    const runId = await seed(store, PROPERTY, items);
    const ms = Date.now() - t0;
    console.log(`  [計測] 300枚の写真結果: ${(bytes / 1024).toFixed(1)}KB / 保存 ${ms}ms`);
    assert.equal((await assertConsistent(store, runId)).items.length, 300);
    await assert.rejects(
      store.saveRun(runId, { target: PROPERTY, baseRev: 1, items: [doneItem(randomUUID(), 1, 300)] }),
      (e: HistoryError) => e.code === "too_many_items"
    );
    assert.equal((await store.getRun(runId))!.run.rev, 1);
  });
});
