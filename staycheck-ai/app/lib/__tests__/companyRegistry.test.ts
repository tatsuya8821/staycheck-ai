import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * companyRegistry.ts のRedis CRUD・インデックス整合性の自動テスト。
 * 実際のUpstashは使わず、get/set/del/sadd/srem/smembersだけを実装した
 * インメモリのモックRedisを、getRedisClientの代わりに差し込んで検証する。
 * 実在する会社名・物件名は使わず、架空のIDのみ使用する。
 */

class MockRedis {
  kv = new Map<string, unknown>();
  sets = new Map<string, Set<string>>();
  failNextDelOnKey: string | null = null;
  failNextSremOnKey: string | null = null;

  async get<T>(key: string): Promise<T | null> {
    return (this.kv.has(key) ? (this.kv.get(key) as T) : null);
  }
  async set(key: string, value: unknown) {
    this.kv.set(key, value);
  }
  async del(key: string) {
    if (this.failNextDelOnKey === key) {
      this.failNextDelOnKey = null;
      throw new Error("mock del failure");
    }
    this.kv.delete(key);
    this.sets.delete(key);
  }
  async sadd(key: string, member: string) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key)!.add(member);
  }
  async srem(key: string, member: string) {
    if (this.failNextSremOnKey === key) {
      this.failNextSremOnKey = null;
      throw new Error("mock srem failure");
    }
    const s = this.sets.get(key);
    if (!s) return;
    s.delete(member);
    if (s.size === 0) this.sets.delete(key); // 本物のRedisと同様、空のSetは自動削除
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
}

let mock: MockRedis;

/**
 * redis.ts の getRedisClient は、環境変数が両方設定されている場合に
 * @upstash/redis の Redis を new して返す。ここでは本番コードを変更せず、
 * 実在しないダミーURLを環境変数に入れた上で、Node標準のモジュールキャッシュ
 * 経由で @upstash/redis の Redis クラスだけをモックへ差し替える。
 */
async function load() {
  mock = new MockRedis();
  process.env.UPSTASH_REDIS_REST_URL = "https://dummy.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "dummy-token";

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const upstash = require("@upstash/redis");
  const resolved = require.resolve("@upstash/redis");
  // Redisクラスを、モックのインスタンスを返すコンストラクタへ差し替える
  const FakeRedis = function () {
    return mock;
  } as unknown as typeof upstash.Redis;
  require.cache[resolved]!.exports = { ...upstash, Redis: FakeRedis };

  // redis.ts / companyRegistry.ts のキャッシュを消して、差し替え後のRedisを掴ませる
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/app/lib/redis") || key.includes("/app/lib/companyRegistry")) {
      delete require.cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../companyRegistry");
}

describe("companyRegistry: 基本CRUD", () => {
  test("会社を登録して一覧に出る", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    const list = await reg.listCompanies();
    assert.equal(list.length, 1);
    assert.equal(list[0].companyId, "test-co");
  });

  test("会社IDの重複登録はエラー", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await assert.rejects(() => reg.createCompany("test-co", "別名"), /既に登録/);
  });

  test("不正なID(大文字・日本語)はエラー", async () => {
    const reg = await load();
    await assert.rejects(() => reg.createCompany("Test_Co", "x"), /半角英数字/);
    await assert.rejects(() => reg.createCompany("会社", "x"), /半角英数字/);
  });

  test("存在しない会社へ物件は登録できない", async () => {
    const reg = await load();
    await assert.rejects(() => reg.createProperty("no-co", "p1", "物件", ""), /登録されていません/);
  });

  test("物件の登録・取得・更新・削除", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await reg.createProperty("test-co", "p1", "物件1", "ルールA");
    assert.equal((await reg.getProperty("test-co", "p1")).ruleText, "ルールA");

    await reg.updateProperty("test-co", "p1", { ruleText: "ルールB" });
    assert.equal((await reg.getProperty("test-co", "p1")).ruleText, "ルールB");

    await reg.deleteProperty("test-co", "p1");
    assert.equal(await reg.getProperty("test-co", "p1"), null);
    assert.equal((await reg.listProperties("test-co")).length, 0);
  });
});

describe("companyRegistry: カスケード削除と整合性", () => {
  test("会社削除で所属物件もすべて消える", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await reg.createProperty("test-co", "p1", "物件1", "");
    await reg.createProperty("test-co", "p2", "物件2", "");
    await reg.deleteCompany("test-co");

    assert.equal((await reg.listCompanies()).length, 0);
    assert.equal(await reg.getProperty("test-co", "p1"), null);
    assert.equal(await reg.getProperty("test-co", "p2"), null);
    assert.equal(mock.kv.size, 0, "実体データが残っていないこと");
    assert.equal(mock.sets.size, 0, "インデックスが残っていないこと");
  });

  test("別の会社の物件は、会社削除の影響を受けない", async () => {
    const reg = await load();
    await reg.createCompany("co-a", "A");
    await reg.createCompany("co-b", "B");
    await reg.createProperty("co-a", "p1", "A物件", "");
    await reg.createProperty("co-b", "p1", "B物件", "");
    await reg.deleteCompany("co-a");

    assert.equal((await reg.getProperty("co-b", "p1")).propertyLabel, "B物件");
    assert.equal((await reg.listCompanies()).length, 1);
  });

  test("インデックスに実体のないIDが残っても、一覧はエラーにならず静かに除外する", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await reg.createProperty("test-co", "p1", "物件1", "");
    await reg.createProperty("test-co", "p2", "物件2", "");
    // 実体だけ消し、インデックスには残した「壊れた」状態を作る
    mock.kv.delete("property:test-co:p1");

    const list = await reg.listProperties("test-co");
    assert.deepEqual(list.map((p: { propertyId: string }) => p.propertyId), ["p2"]);
  });

  test("カスケード削除が途中(SREM)で失敗しても、再実行で完全に片付く", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await reg.createProperty("test-co", "p1", "物件1", "");
    await reg.createProperty("test-co", "p2", "物件2", "");

    mock.failNextSremOnKey = "properties:index:test-co";
    await assert.rejects(() => reg.deleteCompany("test-co"), /mock srem failure/);

    // 失敗直後でも、一覧は壊れない(会社は残っているが、実体のない物件IDは除外される)
    const afterFail = await reg.listProperties("test-co");
    assert.ok(afterFail.length <= 1, "削除済みの物件は一覧に出ないこと");

    // 再実行で完全に消える
    await reg.deleteCompany("test-co");
    assert.equal((await reg.listCompanies()).length, 0);
    assert.equal(mock.kv.size, 0);
    assert.equal(mock.sets.size, 0);
  });

  test("カスケード削除が会社実体の削除(DEL)で失敗しても、会社は残るだけで再実行できる", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await reg.createProperty("test-co", "p1", "物件1", "");

    mock.failNextDelOnKey = "company:test-co";
    await assert.rejects(() => reg.deleteCompany("test-co"), /mock del failure/);

    // 物件は消えているが会社は残る(壊れた状態ではない)
    assert.equal((await reg.listProperties("test-co")).length, 0);
    assert.equal((await reg.listCompanies()).length, 1);

    await reg.deleteCompany("test-co");
    assert.equal((await reg.listCompanies()).length, 0);
  });
});

describe("companyRegistry: loadRegistrySnapshot", () => {
  test("会社・物件が resolveRules に渡せる形で返る", async () => {
    const reg = await load();
    await reg.createCompany("test-co", "テスト会社");
    await reg.createProperty("test-co", "p1", "物件1", "鍵は3本");
    const snap = await reg.loadRegistrySnapshot();
    assert.equal(snap.companies.length, 1);
    assert.equal(snap.properties.length, 1);
    assert.equal(snap.properties[0].ruleText, "鍵は3本");
  });
});
