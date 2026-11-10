import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isValidRunIdFormat,
  isValidTarget,
  issueRunId,
  runIdCreatedAtMs,
  runTimes,
  verifyRunId,
  HISTORY_RETENTION_MS,
  HISTORY_WRITE_MARGIN_MS,
} from "../history/runId";

/** 履歴ID(runId)の発行・署名検証。架空のIDのみ使用する */

const SECRET = "unit-test-secret";
const NOW = 1_790_000_000_000;
const PROPERTY = { mode: "property" as const, companyId: "test-co", propertyId: "room-1" };

describe("runId: 発行と検証", () => {
  test("発行したIDは形式が正しく、同じ対象で検証に通る", () => {
    const id = issueRunId(PROPERTY, SECRET, NOW);
    assert.ok(isValidRunIdFormat(id));
    assert.ok(verifyRunId(id, PROPERTY, SECRET));
    assert.equal(runIdCreatedAtMs(id), NOW);
  });

  test("毎回異なるIDになる", () => {
    assert.notEqual(issueRunId(PROPERTY, SECRET, NOW), issueRunId(PROPERTY, SECRET, NOW));
  });

  test("改ざん(作成時刻・ランダム値・署名)は検証に失敗する", () => {
    const id = issueRunId(PROPERTY, SECRET, NOW);
    const [ts, nonce, sig] = id.split(".");
    const tsForged = (NOW + 1000).toString(36);
    assert.equal(verifyRunId(`${tsForged}.${nonce}.${sig}`, PROPERTY, SECRET), false);
    const nonceForged = nonce.slice(0, -1) + (nonce.endsWith("A") ? "B" : "A");
    assert.equal(verifyRunId(`${ts}.${nonceForged}.${sig}`, PROPERTY, SECRET), false);
    const sigForged = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    assert.equal(verifyRunId(`${ts}.${nonce}.${sigForged}`, PROPERTY, SECRET), false);
  });

  test("別の対象・別の秘密鍵では検証に失敗する", () => {
    const id = issueRunId(PROPERTY, SECRET, NOW);
    assert.equal(verifyRunId(id, { ...PROPERTY, propertyId: "room-2" }, SECRET), false);
    assert.equal(verifyRunId(id, { mode: "company", companyId: "test-co" }, SECRET), false);
    assert.equal(verifyRunId(id, { mode: "standard" }, SECRET), false);
    assert.equal(verifyRunId(id, PROPERTY, "other-secret"), false);
  });

  test("不正な形式は拒否する(キー注入・パス操作の防止)", () => {
    const bad = [
      "",
      "../../etc/passwd",
      "history:run:*",
      "abc",
      "mv3c8mk9.hMvFN2_tS3HKCYHo.Nk2Rh6YBvujuOgpVU2Vik1x",
      "mv3c8mk9.hMvFN2_tS3HKCYH*.Nk2Rh6YBvujuOgpVU2Vik1",
      "mv3c8mk9:hMvFN2_tS3HKCYHo:Nk2Rh6YBvujuOgpVU2Vik1",
      "a".repeat(500),
      null,
      123,
    ];
    for (const b of bad) assert.equal(isValidRunIdFormat(b), false, String(b));
  });

  test("期限: 作成時刻+180日、保存の締切はその10分前", () => {
    const id = issueRunId(PROPERTY, SECRET, NOW);
    const t = runTimes(id);
    assert.equal(t.expiresAtMs, NOW + HISTORY_RETENTION_MS);
    assert.equal(t.writeDeadlineMs, NOW + HISTORY_RETENTION_MS - HISTORY_WRITE_MARGIN_MS);
    assert.equal(HISTORY_RETENTION_MS, 180 * 24 * 60 * 60 * 1000);
  });
});

describe("runId: 対象の組み合わせ", () => {
  test("正しい組み合わせ", () => {
    assert.ok(isValidTarget({ mode: "standard" }));
    assert.ok(isValidTarget({ mode: "company", companyId: "test-co" }));
    assert.ok(isValidTarget(PROPERTY));
  });
  test("不正な組み合わせ・形式", () => {
    assert.equal(isValidTarget({ mode: "standard", companyId: "test-co" }), false);
    assert.equal(isValidTarget({ mode: "company" }), false);
    assert.equal(isValidTarget({ mode: "company", companyId: "test-co", propertyId: "room-1" }), false);
    assert.equal(isValidTarget({ mode: "property", companyId: "test-co" }), false);
    assert.equal(isValidTarget({ mode: "property", companyId: "TEST_CO", propertyId: "room-1" }), false);
    assert.equal(isValidTarget({ mode: "company", companyId: "a:b" }), false);
    assert.equal(isValidTarget({ mode: "admin" }), false);
    assert.equal(isValidTarget(null), false);
  });
});
