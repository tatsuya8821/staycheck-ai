import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveRules } from "../resolveRules";
import { registry } from "../registry";
import { STANDARD_RULES } from "../standard";
import { RuleResolutionError, RuleDefinition } from "../types";

/**
 * resolveRules() の自動テスト。
 *
 * 実在する会社名・物件名は一切使わず、架空のテストデータのみを使用する。
 * registry.ts本体(空配列)は変更せず、各テストの実行中だけ
 * beforeEach/afterEachでフェイクの会社・物件データを追加・削除する
 * (テスト以外のどこにも永続しない)。
 */

const FAKE_COMPANY_ID = "test-company-alpha";
const FAKE_UNKNOWN_COMPANY_ID = "test-company-does-not-exist";
const FAKE_PROPERTY_ID = "test-property-001";
const FAKE_UNKNOWN_PROPERTY_ID = "test-property-does-not-exist";

// 標準ルールと同じidを持つ会社別ルール(上書き確認用)+新規idのルール(追加確認用)
const FAKE_COMPANY_RULES: RuleDefinition[] = [
  {
    id: "judgment-tiers", // STANDARD_RULESに実在するidと同じにして、上書きを検証する
    category: "output",
    order: 90,
    enabled: true,
    source: "company",
    instruction: "【テスト用に上書きされた会社別ルール: judgment-tiers】",
  },
  {
    id: "company-only-rule",
    category: "company-specific",
    order: 50,
    enabled: true,
    source: "company",
    instruction: "【テスト用の会社別ルール: 会社にのみ存在する新規ルール】",
  },
];

const FAKE_PROPERTY_RULES: RuleDefinition[] = [
  {
    id: "company-only-rule", // 会社別ルールと同じidにして、物件が会社より優先されることを検証する
    category: "company-specific",
    order: 50,
    enabled: true,
    source: "property",
    instruction: "【テスト用に上書きされた物件別ルール: company-only-rule】",
  },
  {
    id: "property-only-rule",
    category: "property-specific",
    order: 60,
    enabled: true,
    source: "property",
    instruction: "【テスト用の物件別ルール: 物件にのみ存在する新規ルール】",
  },
];

beforeEach(() => {
  registry.companies.push({
    companyId: FAKE_COMPANY_ID,
    companyLabel: "テスト用会社アルファ",
    rules: FAKE_COMPANY_RULES,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  registry.properties.push({
    companyId: FAKE_COMPANY_ID,
    propertyId: FAKE_PROPERTY_ID,
    propertyLabel: "テスト用物件001",
    schemaVersion: 1,
    ruleText: "",
    // structuredRulesがあればそちらが優先されるため、既存のマージ検証
    // (同一id上書き・新規id追加)は、この予約フィールド経由でそのまま検証する。
    structuredRules: FAKE_PROPERTY_RULES,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

afterEach(() => {
  // 次のテストへ影響しないよう、追加したフェイクデータを確実に取り除く
  registry.companies = registry.companies.filter((c) => c.companyId !== FAKE_COMPANY_ID);
  registry.properties = registry.properties.filter((p) => p.companyId !== FAKE_COMPANY_ID);
});

describe("resolveRules: 6パターン", () => {
  test("1. companyId未指定 → 標準基準のみが返る", () => {
    const result = resolveRules(undefined, undefined);
    const ids = result.map((r) => r.id);
    for (const standardRule of STANDARD_RULES) {
      assert.ok(ids.includes(standardRule.id), `標準ルール ${standardRule.id} が含まれるはず`);
    }
    assert.ok(
      result.every((r) => r.source === "standard"),
      "companyId未指定時は、すべてsource=standardのはず"
    );
  });

  test("2. companyId未指定 + propertyId指定 → property_without_companyエラー", () => {
    assert.throws(
      () => resolveRules(undefined, FAKE_PROPERTY_ID),
      (err: unknown) => {
        assert.ok(err instanceof RuleResolutionError);
        assert.equal(err.code, "property_without_company");
        return true;
      }
    );
  });

  test("3. 未登録のcompanyId → unknown_companyエラー", () => {
    assert.throws(
      () => resolveRules(FAKE_UNKNOWN_COMPANY_ID, undefined),
      (err: unknown) => {
        assert.ok(err instanceof RuleResolutionError);
        assert.equal(err.code, "unknown_company");
        return true;
      }
    );
  });

  test("4. 登録済みcompanyId + propertyId未指定 → 標準+会社(会社が同idを上書き)", () => {
    const result = resolveRules(FAKE_COMPANY_ID, undefined);
    const byId = new Map(result.map((r) => [r.id, r]));

    // 会社別ルールが標準ルールと同じidを上書きしていること
    assert.equal(byId.get("judgment-tiers")?.source, "company");
    assert.equal(
      byId.get("judgment-tiers")?.instruction,
      "【テスト用に上書きされた会社別ルール: judgment-tiers】"
    );
    // 会社にのみ存在する新規ルールが追加されていること
    assert.equal(byId.get("company-only-rule")?.source, "company");
    // 物件別ルールはまだ適用されていないこと
    assert.equal(byId.has("property-only-rule"), false);
  });

  test("5. 登録済みcompanyId + 未登録propertyId → unknown_propertyエラー", () => {
    assert.throws(
      () => resolveRules(FAKE_COMPANY_ID, FAKE_UNKNOWN_PROPERTY_ID),
      (err: unknown) => {
        assert.ok(err instanceof RuleResolutionError);
        assert.equal(err.code, "unknown_property");
        return true;
      }
    );
  });

  test("6. 登録済みcompanyId + 登録済みpropertyId → 標準+会社+物件(物件が最優先)", () => {
    const result = resolveRules(FAKE_COMPANY_ID, FAKE_PROPERTY_ID);
    const byId = new Map(result.map((r) => [r.id, r]));

    // 物件別ルールが、会社別ルールと同じidを上書きしていること(物件 > 会社 > 標準)
    assert.equal(byId.get("company-only-rule")?.source, "property");
    assert.equal(
      byId.get("company-only-rule")?.instruction,
      "【テスト用に上書きされた物件別ルール: company-only-rule】"
    );
    // 物件にのみ存在する新規ルールが追加されていること
    assert.equal(byId.get("property-only-rule")?.source, "property");
    // 会社別ルール(物件で上書きされていないもの)も引き続き含まれること
    assert.equal(byId.get("judgment-tiers")?.source, "company");
  });
});

describe("resolveRules: 補足の挙動", () => {
  test("enabled:falseのルールは最終結果に含まれない", () => {
    registry.companies.push({
      companyId: "test-company-disabled-rule",
      companyLabel: "テスト用(無効化ルール確認)",
      rules: [
        {
          id: "judgment-tiers",
          category: "output",
          enabled: false, // 標準ルールを無効化する
          source: "company",
          instruction: "無効化されるはずなので出力に含まれてはならない",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = resolveRules("test-company-disabled-rule", undefined);
    assert.equal(
      result.find((r) => r.id === "judgment-tiers"),
      undefined,
      "enabled:falseのルールは最終結果から除外されるはず"
    );

    registry.companies = registry.companies.filter(
      (c) => c.companyId !== "test-company-disabled-rule"
    );
  });

  test("同一idの上書きは重複を生まない(件数が増えない)", () => {
    const beforeCount = resolveRules(undefined, undefined).length;
    const afterCount = resolveRules(FAKE_COMPANY_ID, undefined).length;
    // 会社別ルールは「judgment-tiers(上書き)」+「company-only-rule(新規)」の2件。
    // 上書きは件数を増やさないので、標準の件数+新規1件だけ増えるはず。
    assert.equal(afterCount, beforeCount + 1);
  });
});
