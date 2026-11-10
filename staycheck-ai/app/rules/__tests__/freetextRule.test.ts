import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveRules } from "../resolveRules";
import { RuleRegistry } from "../types";

/**
 * 物件の自由記述ルール(ruleText)が、物件固有IDの RuleDefinition として
 * 統合されることのテスト。registryOverride を使うため、静的な
 * registry.ts(空)には一切触れない。架空データのみ使用。
 */

function makeRegistry(ruleTextA: string, ruleTextB: string): RuleRegistry {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    companies: [{ companyId: "co", companyLabel: "テスト会社", rules: [], createdAt: ts, updatedAt: ts }],
    properties: [
      { companyId: "co", propertyId: "pa", propertyLabel: "A", schemaVersion: 1, ruleText: ruleTextA, createdAt: ts, updatedAt: ts },
      { companyId: "co", propertyId: "pb", propertyLabel: "B", schemaVersion: 1, ruleText: ruleTextB, createdAt: ts, updatedAt: ts },
    ],
  };
}

describe("自由記述ルールの物件固有ID化", () => {
  test("idは property:{companyId}:{propertyId}:freetext 形式になる", () => {
    const rules = resolveRules("co", "pa", makeRegistry("鍵は3本", "別ルール"));
    const freetext = rules.find((r) => r.source === "property");
    assert.equal(freetext?.id, "property:co:pa:freetext");
    assert.equal(freetext?.instruction, "鍵は3本");
  });

  test("別の物件を選ぶと、別の物件固有IDになり、他物件のルールは混入しない", () => {
    const reg = makeRegistry("Aのルール", "Bのルール");
    const a = resolveRules("co", "pa", reg);
    const b = resolveRules("co", "pb", reg);
    assert.equal(a.find((r) => r.source === "property")?.id, "property:co:pa:freetext");
    assert.equal(b.find((r) => r.source === "property")?.id, "property:co:pb:freetext");
    assert.ok(!a.some((r) => r.instruction === "Bのルール"));
    assert.ok(!b.some((r) => r.instruction === "Aのルール"));
  });

  test("ruleTextが空(空白のみ含む)なら、物件ルールは追加されない", () => {
    const rules = resolveRules("co", "pa", makeRegistry("   ", ""));
    assert.ok(rules.every((r) => r.source !== "property"));
  });

  test("会社のみ選択(物件未選択)では、物件ルールは含まれない", () => {
    const rules = resolveRules("co", undefined, makeRegistry("Aのルール", "Bのルール"));
    assert.ok(rules.every((r) => r.source !== "property"));
  });

  test("companyId未指定(標準モード)ではregistryOverrideがあっても標準基準のみ", () => {
    const rules = resolveRules(undefined, undefined, makeRegistry("Aのルール", "Bのルール"));
    assert.ok(rules.every((r) => r.source === "standard"));
  });
});
