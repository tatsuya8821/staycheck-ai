import { PropertyRuleSet, RuleDefinition, RuleRegistry, RuleResolutionError } from "./types";
import { STANDARD_RULES } from "./standard";
import { registry as defaultRegistry } from "./registry";

/**
 * 同じidがあれば「丸ごと置き換え」、無いidは追加する。
 * 自然文で優先順位をAIに委ねるのではなく、ここで確定的に1件だけ残す。
 */
function mergeById(base: RuleDefinition[], overlay: RuleDefinition[]): RuleDefinition[] {
  const map = new Map(base.map((r) => [r.id, r]));
  for (const rule of overlay) {
    map.set(rule.id, rule);
  }
  return [...map.values()];
}

/**
 * 物件のPropertyRuleSetを、統合処理で使えるRuleDefinition[]に変換する。
 * - structuredRules(将来の構造化ルール)があればそちらを優先する。
 * - 無ければ、自由記述のruleTextを1件のRuleDefinitionとしてラップする。
 *   idは固定値ではなく物件固有のID(`property:{companyId}:{propertyId}:freetext`)
 *   にすることで、将来複数物件のルールを同時に扱う場合にも衝突しない。
 * - ruleTextが空文字なら何も追加しない。
 */
function toRuleDefinitions(property: PropertyRuleSet): RuleDefinition[] {
  if (property.structuredRules && property.structuredRules.length > 0) {
    return property.structuredRules;
  }
  if (!property.ruleText || property.ruleText.trim() === "") {
    return [];
  }
  return [
    {
      id: `property:${property.companyId}:${property.propertyId}:freetext`,
      category: "property",
      instruction: property.ruleText,
      enabled: true,
      source: "property",
      order: 80,
    },
  ];
}

/**
 * companyId・propertyId に応じて、標準・会社・物件のルールを解決する。
 *
 * - companyId未指定: 標準基準のみ
 * - companyId未指定 + propertyId指定: エラー(property_without_company)
 * - 未登録のcompanyId: エラー(unknown_company)
 * - 登録済みcompany + propertyId未指定: 標準+会社
 * - 登録済みcompany + 未登録propertyId: エラー(unknown_property)
 * - 登録済みcompany + 登録済みpropertyId: 標準+会社+物件
 *
 * 会社・物件の指定ミスがあった場合、会社固有ルールが適用されないまま
 * 判定が進んでしまう事態を防ぐため、標準モードへ黙って戻さず例外を投げる。
 *
 * registryOverride: 省略時はapp/rules/registry.ts(静的な空データ、既存の
 * 自動テストが直接書き換えて使う)を参照する。実際のAPI(route.ts)からは、
 * Redisから取得した最新のレジストリをこの引数で渡す。
 */
export function resolveRules(
  companyId: string | undefined,
  propertyId: string | undefined,
  registryOverride?: RuleRegistry
): RuleDefinition[] {
  const registry = registryOverride ?? defaultRegistry;

  if (!companyId && propertyId) {
    throw new RuleResolutionError(
      "property_without_company",
      "物件IDを指定する場合は会社IDも必要です。"
    );
  }

  let merged = mergeById([], STANDARD_RULES);

  if (!companyId) {
    return finalize(merged);
  }

  const company = registry.companies.find((c) => c.companyId === companyId);
  if (!company) {
    throw new RuleResolutionError(
      "unknown_company",
      `会社ID "${companyId}" は登録されていません。`
    );
  }
  merged = mergeById(merged, company.rules);

  if (!propertyId) {
    return finalize(merged);
  }

  const property = registry.properties.find(
    (p) => p.companyId === companyId && p.propertyId === propertyId
  );
  if (!property) {
    throw new RuleResolutionError(
      "unknown_property",
      `物件ID "${propertyId}" は会社 "${companyId}" 内に登録されていません。`
    );
  }
  merged = mergeById(merged, toRuleDefinitions(property));

  return finalize(merged);
}

/** enabled:falseのルールを除去し、category順→order順で並べる */
function finalize(rules: RuleDefinition[]): RuleDefinition[] {
  return rules
    .filter((r) => r.enabled)
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
