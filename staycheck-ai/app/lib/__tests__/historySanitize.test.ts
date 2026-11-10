import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sanitizeSaveRequest, sanitizeItem, LIMITS } from "../history/sanitize";
import { classifyJudgeError } from "../history/client";
import { RateLimitExhaustedError } from "../judgePhoto";
import { HistoryError } from "../history/errors";

/** 保存リクエストの検査(許可項目のみ保存・文字数上限・機密情報を残さない) */

function rawDone(overrides: Record<string, unknown> = {}) {
  return {
    photoKey: randomUUID(),
    gen: 1,
    fileName: "dummy.jpg",
    source: "drive",
    category: "auto",
    propertyName: "サンプル物件101",
    status: "done",
    judgment: "◎ 良好",
    summary: "問題なし",
    checks: [{ label: "床", ok: true }],
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 0 },
    judgedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}
const isCode = (code: string) => (e: unknown) => e instanceof HistoryError && e.code === code;

describe("sanitize: 保存しない情報", () => {
  test("DriveファイルID・エラー文面・ルール本文・その他の項目は捨てる", () => {
    const item = sanitizeItem(
      rawDone({
        driveFileId: "1AbCdEfGhIjKlMnOp",
        errorMsg: "Google API error: invalid_grant token=ya29.xxx",
        ruleText: "キーボックスの番号は1234",
        previewUrl: "blob:http://localhost/xyz",
        file: { secret: true },
      })
    );
    const json = JSON.stringify(item);
    for (const s of ["driveFileId", "1AbCdEfGhIjKlMnOp", "errorMsg", "invalid_grant", "ruleText", "1234", "previewUrl", "blob:"]) {
      assert.equal(json.includes(s), false, `${s} が含まれていない`);
    }
  });

  test("エラーは分類コードだけを残す(未知のコードは judge_failed)", () => {
    const e = sanitizeItem({ ...rawDone(), status: "error", errorCode: "rate_limited", errorMsg: "生のエラー" });
    assert.equal(e.errorCode, "rate_limited");
    assert.equal("errorMsg" in e, false);
    assert.equal("judgment" in e, false);
    const unknown = sanitizeItem({ ...rawDone(), status: "error", errorCode: "Error: ECONNRESET 10.0.0.1" });
    assert.equal(unknown.errorCode, "judge_failed");
  });
});

describe("sanitize: 文字数・形式", () => {
  test("長い文字列は上限で切り詰め、制御文字は除く", () => {
    const item = sanitizeItem(
      rawDone({
        fileName: "あ".repeat(500),
        summary: "い".repeat(2000),
        propertyName: "物件\n名\t" + "う".repeat(200),
        checks: Array.from({ length: 50 }, (_, i) => ({ label: "え".repeat(300), ok: i % 2 === 0 })),
      })
    );
    assert.equal(Array.from(item.fileName).length, LIMITS.fileName);
    assert.equal(Array.from(item.summary!).length, LIMITS.summary);
    assert.equal(Array.from(item.propertyName).length, LIMITS.propertyName);
    assert.equal(/[\n\t]/.test(item.propertyName), false);
    assert.equal(item.checks!.length, LIMITS.checks);
    assert.equal(Array.from(item.checks![0].label).length, LIMITS.checkLabel);
  });

  test("4段階以外の判定・不正な写真ID・世代番号・カテゴリは拒否する", () => {
    assert.throws(() => sanitizeItem(rawDone({ judgment: "× 不合格" })), isCode("invalid_request"));
    assert.throws(() => sanitizeItem(rawDone({ photoKey: "../x" })), isCode("invalid_request"));
    assert.throws(() => sanitizeItem(rawDone({ gen: 0 })), isCode("invalid_request"));
    assert.throws(() => sanitizeItem(rawDone({ gen: 1.5 })), isCode("invalid_request"));
    assert.throws(() => sanitizeItem(rawDone({ category: "secret" })), isCode("invalid_request"));
    assert.throws(() => sanitizeItem(rawDone({ status: "pending" })), isCode("invalid_request"));
    assert.throws(() => sanitizeItem(rawDone({ judgedAt: "昨日" })), isCode("invalid_request"));
  });
});

describe("sanitize: リクエスト全体", () => {
  const target = { mode: "standard" };

  test("同じ写真が複数あれば世代番号の大きいものを採用", () => {
    const k = randomUUID();
    const req = sanitizeSaveRequest({ target, baseRev: 0, items: [rawDone({ photoKey: k, gen: 2 }), rawDone({ photoKey: k, gen: 5 }), rawDone({ photoKey: k, gen: 3 })] });
    assert.equal(req.items.length, 1);
    assert.equal(req.items[0].gen, 5);
  });

  test("写真0枚・301枚・不正な対象・不正な更新番号は拒否", () => {
    assert.throws(() => sanitizeSaveRequest({ target, items: [] }), isCode("invalid_request"));
    assert.throws(
      () => sanitizeSaveRequest({ target, items: Array.from({ length: 301 }, () => rawDone()) }),
      isCode("too_many_items")
    );
    assert.throws(() => sanitizeSaveRequest({ target: { mode: "property" }, items: [rawDone()] }), isCode("invalid_request"));
    assert.throws(() => sanitizeSaveRequest({ target, baseRev: -1, items: [rawDone()] }), isCode("invalid_request"));
    assert.throws(() => sanitizeSaveRequest("not an object"), isCode("invalid_request"));
  });

  test("300枚ちょうどは受け付ける", () => {
    const req = sanitizeSaveRequest({ target, items: Array.from({ length: 300 }, () => rawDone()) });
    assert.equal(req.items.length, 300);
  });
});

describe("classifyJudgeError: エラーの分類", () => {
  test("各分類", () => {
    assert.equal(classifyJudgeError(new Error("x"), "drive"), "drive_fetch_failed");
    assert.equal(classifyJudgeError(new RateLimitExhaustedError("x"), "judge"), "rate_limited");
    assert.equal(classifyJudgeError(new Error("OpenAI APIのクレジット残高が不足している可能性があります。"), "judge"), "quota_exceeded");
    assert.equal(classifyJudgeError(new Error('会社ID "x" は登録されていません。'), "judge"), "rule_error");
    assert.equal(classifyJudgeError(new Error("AI判定APIの呼び出しに失敗しました。"), "judge"), "judge_failed");
    assert.equal(classifyJudgeError("string error", "judge"), "judge_failed");
  });
});
