import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AI_MODEL_LABEL,
  APP_DESCRIPTION_JA,
  APP_INFO_ITEMS,
  APP_NAME,
  APP_SUBTITLE,
  APP_VERSION,
  HISTORY_RETENTION_DAYS,
} from "../appInfo";
import { HISTORY_RETENTION_MS } from "../history/runId";
import { APP_VERSION as STORE_APP_VERSION, JUDGE_MODEL } from "../history/store";

/** アプリ名・バージョン・表示内容の一元管理と、実際の設定値との整合性 */

const root = path.resolve(__dirname, "../../..");
const readJson = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

describe("appInfo: 整合性", () => {
  test("バージョンが package.json・package-lock.json と一致する", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    assert.equal(APP_VERSION, pkg.version);
    assert.equal(APP_VERSION, lock.version);
    assert.equal(APP_VERSION, lock.packages[""].version);
  });

  test("履歴に記録するバージョンも同じ値を使う", () => {
    assert.equal(STORE_APP_VERSION, APP_VERSION);
  });

  test("表示する保存期間が、実際の保存期間(180日)と一致する", () => {
    assert.equal(HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000, HISTORY_RETENTION_MS);
  });

  test("表示するAIモデル名が、判定APIで実際に指定しているモデルと一致する", () => {
    const judgeSource = readFileSync(path.join(root, "app/api/judge/route.ts"), "utf8");
    assert.ok(judgeSource.includes(`model: "${AI_MODEL_LABEL}"`), "判定APIのモデル指定と一致すること");
    assert.equal(JUDGE_MODEL, AI_MODEL_LABEL);
  });
});

describe("appInfo: 表示内容", () => {
  test("名称・説明・副題", () => {
    assert.equal(APP_NAME, "StayCheck AI");
    assert.equal(APP_DESCRIPTION_JA, "宿泊施設向け 清掃写真チェック支援");
    assert.equal(APP_SUBTITLE, "AIが清掃写真を一次チェックし、確認作業を支援します。");
  });

  test("アプリ情報は指定の9項目", () => {
    assert.deepEqual(
      APP_INFO_ITEMS.map((i) => i.label),
      ["アプリ名", "バージョン", "AIの役割", "写真の扱い", "判定履歴の保存期間", "使用しているAI", "料金", "Google Drive連携", "開発状況"]
    );
    const text = APP_INFO_ITEMS.map((i) => i.value).join("\n");
    for (const must of ["StayCheck AI", `v${APP_VERSION}`, "最終的な判断は", "写真そのものは履歴に保存しません", "180日", "OpenAI API", "従量課金", "Google Drive", "試作品"]) {
      assert.ok(text.includes(must), `「${must}」を含む`);
    }
  });

  test("機密情報らしい文字列を含まない", () => {
    const text = JSON.stringify(APP_INFO_ITEMS);
    for (const ng of ["sk-", "process.env", "UPSTASH", "TOKEN", "SECRET", "PASSWORD", "upstash.io", "http://", "https://", "localhost"]) {
      assert.equal(text.includes(ng), false, `「${ng}」を含まない`);
    }
  });
});
