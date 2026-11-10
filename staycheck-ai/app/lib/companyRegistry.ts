import { CompanyRuleSet, PropertyRuleSet, RuleRegistry } from "@/app/rules/types";
import { getRedisClient } from "./redis";

/**
 * 会社・物件管理のRedis CRUD処理。
 *
 * 名前空間: OAuthトークン(tokenStore.ts)とは完全に分離。
 *
 *   company:{companyId}                 → CompanyRuleSet(JSON)
 *   property:{companyId}:{propertyId}   → PropertyRuleSet(JSON)
 *   companies:index                     → Set<companyId>
 *   properties:index:{companyId}        → Set<propertyId>
 *
 * Upstashは全件走査(KEYS等)を推奨しないため、一覧取得は必ず上記の
 * インデックス用Setを経由する。インデックスに載っているのに実体が
 * 見つからない場合は、エラーにせず一覧から静かに除外する(defensive read)。
 * これにより、カスケード削除が途中で失敗しても、一覧表示は常に
 * 「実在するものだけ」を正しく返し続ける。
 */

const ID_PATTERN = /^[a-z0-9-]+$/;

export class RegistryValidationError extends Error {}
export class RegistryNotFoundError extends Error {}

function assertValidId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new RegistryValidationError(
      `${label}は半角英数字とハイフンのみ使用できます(入力値: "${id}")。`
    );
  }
}

function requireRedis() {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error(
      "Upstash Redisが設定されていないため、会社・物件情報を保存できません。UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定してください。"
    );
  }
  return redis;
}

const companyKey = (companyId: string) => `company:${companyId}`;
const propertyKey = (companyId: string, propertyId: string) => `property:${companyId}:${propertyId}`;
const companiesIndexKey = () => "companies:index";
const propertiesIndexKey = (companyId: string) => `properties:index:${companyId}`;

/** 会社一覧を取得する(インデックス経由。実体が無いIDは静かに除外) */
export async function listCompanies(): Promise<CompanyRuleSet[]> {
  const redis = requireRedis();
  const ids = await redis.smembers(companiesIndexKey());
  if (!ids || ids.length === 0) return [];
  const results = await Promise.all(ids.map((id) => redis.get<CompanyRuleSet>(companyKey(id))));
  return results.filter((c): c is CompanyRuleSet => c !== null);
}

/** 会社を新規登録する */
export async function createCompany(companyId: string, companyLabel: string): Promise<CompanyRuleSet> {
  assertValidId(companyId, "会社ID");
  const redis = requireRedis();

  const existing = await redis.get<CompanyRuleSet>(companyKey(companyId));
  if (existing) {
    throw new RegistryValidationError(`会社ID "${companyId}" は既に登録されています。`);
  }

  const now = new Date().toISOString();
  const company: CompanyRuleSet = { companyId, companyLabel, rules: [], createdAt: now, updatedAt: now };
  await redis.set(companyKey(companyId), company);
  await redis.sadd(companiesIndexKey(), companyId);
  return company;
}

/**
 * 会社をカスケード削除する。手順と、各手順で失敗した場合の残存データ:
 *   1. 所属する物件ID一覧を取得(何も変更しない)
 *   2. 物件ごとに「実体削除→インデックスから除去」をペアで実行
 *      (途中失敗しても、処理済みは完全に消え、未処理は無傷。
 *       実体のないIDが残りうるのは「DELだけ成功しSREMが失敗した1件」のみ)
 *   3. 物件インデックス自体を削除(空になったSetはRedisが自動削除するため通常は不要)
 *   4. 会社の実体を削除(失敗時は会社が残るだけで、整合性は保たれる)
 *   5. 会社インデックスから除去(失敗時は実体のない会社IDが残りうる)
 * 「実体のないID」は、上記の一覧取得側の防御処理で静かに除外される。
 * 再実行すれば、残った分だけが処理されて完全に片付く。
 */
export async function deleteCompany(companyId: string): Promise<void> {
  const redis = requireRedis();

  const propertyIds = await redis.smembers(propertiesIndexKey(companyId));
  for (const propertyId of propertyIds) {
    await redis.del(propertyKey(companyId, propertyId));
    await redis.srem(propertiesIndexKey(companyId), propertyId);
  }
  await redis.del(propertiesIndexKey(companyId));
  await redis.del(companyKey(companyId));
  await redis.srem(companiesIndexKey(), companyId);
}

/** 指定した会社の物件一覧を取得する(実体が無いIDは静かに除外) */
export async function listProperties(companyId: string): Promise<PropertyRuleSet[]> {
  const redis = requireRedis();
  const ids = await redis.smembers(propertiesIndexKey(companyId));
  if (!ids || ids.length === 0) return [];
  const results = await Promise.all(
    ids.map((id) => redis.get<PropertyRuleSet>(propertyKey(companyId, id)))
  );
  return results.filter((p): p is PropertyRuleSet => p !== null);
}

/** 物件を1件取得する */
export async function getProperty(companyId: string, propertyId: string): Promise<PropertyRuleSet | null> {
  const redis = requireRedis();
  return await redis.get<PropertyRuleSet>(propertyKey(companyId, propertyId));
}

/** 物件を新規登録する(会社の存在確認込み) */
export async function createProperty(
  companyId: string,
  propertyId: string,
  propertyLabel: string,
  ruleText: string
): Promise<PropertyRuleSet> {
  assertValidId(propertyId, "物件ID");
  const redis = requireRedis();

  const company = await redis.get<CompanyRuleSet>(companyKey(companyId));
  if (!company) {
    throw new RegistryNotFoundError(`会社ID "${companyId}" は登録されていません。`);
  }
  const existing = await redis.get<PropertyRuleSet>(propertyKey(companyId, propertyId));
  if (existing) {
    throw new RegistryValidationError(`物件ID "${propertyId}" は既に登録されています。`);
  }

  const now = new Date().toISOString();
  const property: PropertyRuleSet = {
    companyId,
    propertyId,
    propertyLabel,
    schemaVersion: 1,
    ruleText,
    createdAt: now,
    updatedAt: now,
  };
  await redis.set(propertyKey(companyId, propertyId), property);
  await redis.sadd(propertiesIndexKey(companyId), propertyId);
  return property;
}

/** 物件を更新する(表示名・自由記述ルール) */
export async function updateProperty(
  companyId: string,
  propertyId: string,
  updates: { propertyLabel?: string; ruleText?: string }
): Promise<PropertyRuleSet> {
  const redis = requireRedis();
  const existing = await redis.get<PropertyRuleSet>(propertyKey(companyId, propertyId));
  if (!existing) {
    throw new RegistryNotFoundError(`物件ID "${propertyId}" は会社 "${companyId}" 内に見つかりません。`);
  }
  const updated: PropertyRuleSet = {
    ...existing,
    propertyLabel: updates.propertyLabel ?? existing.propertyLabel,
    ruleText: updates.ruleText ?? existing.ruleText,
    updatedAt: new Date().toISOString(),
  };
  await redis.set(propertyKey(companyId, propertyId), updated);
  return updated;
}

/** 物件を削除する */
export async function deleteProperty(companyId: string, propertyId: string): Promise<void> {
  const redis = requireRedis();
  await redis.del(propertyKey(companyId, propertyId));
  await redis.srem(propertiesIndexKey(companyId), propertyId);
}

/** resolveRules()にそのまま渡せる形のRuleRegistryを、Redisの最新状態から組み立てる */
export async function loadRegistrySnapshot(): Promise<RuleRegistry> {
  const companies = await listCompanies();
  const nested = await Promise.all(companies.map((c) => listProperties(c.companyId)));
  return { companies, properties: nested.flat() };
}
