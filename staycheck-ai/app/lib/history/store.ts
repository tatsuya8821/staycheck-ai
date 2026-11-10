import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { GPT_5_5_PRICING } from "@/app/lib/pricing";
import { APP_VERSION } from "@/app/lib/appInfo";
import { listCompanies, getProperty } from "@/app/lib/companyRegistry";
import { historyErrors, HistoryError } from "./errors";
import { aggregateItems, mergeItems } from "./merge";
import {
  HISTORY_FUTURE_SKEW_MS,
  HISTORY_RETENTION_MS,
  HISTORY_WRITE_MARGIN_MS,
  isValidRunIdFormat,
  isValidTarget,
  issueRunId,
  normalizeTarget,
  runTimes,
  targetFingerprint,
  verifyRunId,
} from "./runId";
import { COMMIT_SCRIPT, DELETE_SCRIPT, SWEEP_INDEX_SCRIPT } from "./scripts";
import type { SaveRequest } from "./sanitize";
import {
  HISTORY_MAX_ITEMS,
  type HistoryHeader,
  type HistoryItem,
  type HistoryRunDetail,
  type HistoryRunSummary,
  type HistoryTarget,
} from "./types";

/**
 * 判定履歴のRedis読み書き。
 *
 * キー構成(会社・物件・OAuthトークンとは別の名前空間):
 *   history:run:{runId}              概要(文字列。"v1\n更新番号\n期限\n対象\n概要JSON")
 *   history:items:{runId}:r{更新番号}  写真結果(JSON配列の文字列)。概要が指す番号のものだけが有効
 *   history:tomb:{runId}             削除済みの印(本来の期限まで残す)
 *   history:idx:all                  全履歴の並び順(Sorted Set、値=作成時刻ミリ秒)
 *   history:idx:co:{companyId}       会社での絞り込み用
 *   history:idx:prop:{cid}:{pid}     物件での絞り込み用
 *   history:sweep:cursor             インデックス補修の進み具合(1日で消える)
 *
 * すべての履歴データ(概要・写真結果・削除済みの印)は「作成時刻+180日」の同じ絶対時刻で
 * 期限切れになる。インデックスは最も新しい履歴の期限まで残り、読み込み時は常に
 * 保存期間内の範囲だけを取得する。
 */

// アプリのバージョンは app/lib/appInfo.ts で一元管理する(v0.4.2〜)
export { APP_VERSION };
export const JUDGE_MODEL = "gpt-5.5";

const keys = {
  run: (runId: string) => `history:run:${runId}`,
  tomb: (runId: string) => `history:tomb:${runId}`,
  items: (runId: string, rev: number) => `history:items:${runId}:r${rev}`,
  idxAll: () => "history:idx:all",
  idxCompany: (cid: string) => `history:idx:co:${cid}`,
  idxProperty: (cid: string, pid: string) => `history:idx:prop:${cid}:${pid}`,
  sweepCursor: () => "history:sweep:cursor",
};

/** 対象モードに応じて登録するインデックス */
export function indexKeysFor(target: HistoryTarget): string[] {
  const t = normalizeTarget(target);
  const list = [keys.idxAll()];
  if (t.companyId) list.push(keys.idxCompany(t.companyId));
  if (t.companyId && t.propertyId) list.push(keys.idxProperty(t.companyId, t.propertyId));
  return list;
}

/** 履歴に付ける会社名・物件名・ルール指紋(会社・物件が見つからなければnull) */
export interface TargetInfo {
  companyLabel?: string;
  propertyLabel?: string;
  ruleFingerprint?: HistoryHeader["ruleFingerprint"];
}
export type TargetLookup = (target: HistoryTarget) => Promise<TargetInfo | null>;

export function ruleTextFingerprint(ruleText: string): string {
  return createHash("sha256").update(ruleText, "utf8").digest("hex").slice(0, 12);
}

/** 物件管理(companyRegistry)から表示名とルール指紋を取得する。ルール本文は返さない */
export const registryTargetLookup: TargetLookup = async (target) => {
  if (target.mode === "standard") return {};
  const company = (await listCompanies()).find((c) => c.companyId === target.companyId);
  if (!company) return null;
  if (target.mode === "company") return { companyLabel: company.companyLabel };
  const property = await getProperty(target.companyId!, target.propertyId!);
  if (!property) return null;
  return {
    companyLabel: company.companyLabel,
    propertyLabel: property.propertyLabel,
    ruleFingerprint: {
      propertyUpdatedAt: property.updatedAt,
      ruleTextSha256: ruleTextFingerprint(property.ruleText ?? ""),
    },
  };
};

interface Envelope {
  rev: number;
  expiresAtMs: number;
  imm: string;
  header: HistoryHeader;
}

export function parseEnvelope(raw: string): Envelope | null {
  const m = /^v1\n(\d+)\n(\d+)\n([^\n]*)\n/.exec(raw);
  if (!m) return null;
  try {
    return { rev: Number(m[1]), expiresAtMs: Number(m[2]), imm: m[3], header: JSON.parse(raw.slice(m[0].length)) };
  } catch {
    return null;
  }
}

export interface HistoryStoreDeps {
  redis: Redis;
  secret: string;
  now?: () => number;
  retentionMs?: number;
  writeMarginMs?: number;
  lookupTarget?: TargetLookup;
  /** 自動テスト専用の障害注入(保存・削除スクリプトの指定位置でエラーを起こす) */
  failAt?: { commit?: number; delete?: number };
  /** 更新番号の衝突時の再試行回数 */
  maxAttempts?: number;
}

export interface ListFilter {
  companyId?: string;
  propertyId?: string;
  /** 直近n日(省略時は保存期間全体) */
  days?: number;
  offset?: number;
  limit?: number;
}

export interface SaveResult {
  status: "saved" | "unchanged";
  rev: number;
  run: HistoryRunSummary;
  staleIgnored: number;
  conflicts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HistoryStore {
  private readonly redis: Redis;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly writeMarginMs: number;
  private readonly lookupTarget: TargetLookup;
  private readonly failAt: { commit?: number; delete?: number };
  private readonly maxAttempts: number;

  constructor(deps: HistoryStoreDeps) {
    this.redis = deps.redis;
    this.secret = deps.secret;
    this.now = deps.now ?? Date.now;
    this.retentionMs = deps.retentionMs ?? HISTORY_RETENTION_MS;
    this.writeMarginMs = deps.writeMarginMs ?? HISTORY_WRITE_MARGIN_MS;
    this.lookupTarget = deps.lookupTarget ?? registryTargetLookup;
    this.failAt = deps.failAt ?? {};
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  /** 新しい履歴IDを発行する(この時点ではRedisに何も書き込まない) */
  async issueRun(target: HistoryTarget): Promise<{ runId: string; expiresAt: string }> {
    if (!isValidTarget(target)) throw historyErrors.invalid("履歴の対象(モード・会社・物件)が正しくありません。");
    const t = normalizeTarget(target);
    if (t.mode !== "standard" && (await this.lookupTarget(t)) === null) throw historyErrors.targetNotFound();
    const runId = issueRunId(t, this.secret, this.now());
    return { runId, expiresAt: new Date(runTimes(runId, this.retentionMs).expiresAtMs).toISOString() };
  }

  private async readSnapshot(runId: string) {
    const [raw, tomb] = await Promise.all([
      this.redis.get<string>(keys.run(runId)),
      this.redis.exists(keys.tomb(runId)),
    ]);
    if (raw === null || raw === undefined) return { env: null, tomb: tomb > 0, items: null };
    const env = parseEnvelope(String(raw));
    if (!env) throw historyErrors.corrupt();
    const itemsRaw = await this.redis.get<string>(keys.items(runId, env.rev));
    let items: HistoryItem[] | null = null;
    if (itemsRaw !== null && itemsRaw !== undefined) {
      try {
        items = JSON.parse(String(itemsRaw)) as HistoryItem[];
      } catch {
        throw historyErrors.corrupt();
      }
    }
    return { env, tomb: tomb > 0, items };
  }

  /**
   * 写真結果を保存する。再判定した写真だけが更新され、それ以外の写真結果は変わらない。
   * 同じ内容の再送では更新番号を増やさない(インデックスと期限の補修だけ行う)。
   */
  async saveRun(runId: string, req: SaveRequest): Promise<SaveResult> {
    if (!isValidRunIdFormat(runId)) throw historyErrors.invalidRunId();
    const target = normalizeTarget(req.target);
    if (!verifyRunId(runId, target, this.secret)) throw historyErrors.forbidden();
    const times = runTimes(runId, this.retentionMs, this.writeMarginMs);
    if (times.createdAtMs > this.now() + HISTORY_FUTURE_SKEW_MS) throw historyErrors.invalidRunId();
    if (this.now() >= times.writeDeadlineMs) throw historyErrors.expired();
    const imm = targetFingerprint(target);

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const snap = await this.readSnapshot(runId);
      if (snap.tomb) throw historyErrors.gone();
      if (snap.env && snap.env.imm !== imm) throw historyErrors.forbidden();
      if (!snap.env && req.baseRev > 0) throw historyErrors.gone();
      if (snap.env && snap.items === null) {
        // 概要を読んだ直後に別の保存が公開された(古い写真結果キーが削除済み)。読み直す
        await sleep(20 + Math.random() * 60);
        continue;
      }

      const merged = mergeItems(snap.items ?? [], req.items);
      if (merged.items.length > HISTORY_MAX_ITEMS) throw historyErrors.tooManyItems();
      const expectedRev = snap.env?.rev ?? 0;
      const now = this.now();

      let header: HistoryHeader | null = null;
      if (merged.changed) {
        const info = await this.lookupTarget(target);
        const prev = snap.env?.header;
        const agg = aggregateItems(merged.items);
        header = {
          schemaVersion: 1,
          runId,
          createdAt: prev?.createdAt ?? new Date(times.createdAtMs).toISOString(),
          expiresAt: new Date(times.expiresAtMs).toISOString(),
          updatedAt: new Date(now).toISOString(),
          mode: target.mode,
          ...(target.companyId ? { companyId: target.companyId } : {}),
          ...(target.propertyId ? { propertyId: target.propertyId } : {}),
          // 会社・物件が削除済みなら、以前保存した表示名を残す
          ...(info?.companyLabel ?? prev?.companyLabel ? { companyLabel: info?.companyLabel ?? prev?.companyLabel } : {}),
          ...(info?.propertyLabel ?? prev?.propertyLabel ? { propertyLabel: info?.propertyLabel ?? prev?.propertyLabel } : {}),
          ...(info?.ruleFingerprint ?? prev?.ruleFingerprint
            ? { ruleFingerprint: info?.ruleFingerprint ?? prev?.ruleFingerprint }
            : {}),
          ...agg,
          pricing: { ...GPT_5_5_PRICING },
          model: JUDGE_MODEL,
          appVersion: APP_VERSION,
          ...(req.batchStats ?? prev?.lastBatch ? { lastBatch: req.batchStats ?? prev?.lastBatch } : {}),
        };
      }

      const op = merged.changed ? "commit" : "touch";
      const res = (await this.redis.eval(
        COMMIT_SCRIPT,
        [
          keys.run(runId),
          keys.tomb(runId),
          keys.items(runId, expectedRev + 1),
          keys.items(runId, expectedRev),
          ...indexKeysFor(target),
        ],
        [
          op,
          String(expectedRev),
          String(now),
          String(times.expiresAtMs),
          String(times.writeDeadlineMs),
          imm,
          String(now - this.retentionMs),
          runId,
          String(times.createdAtMs),
          String(this.failAt.commit ?? 0),
          header ? JSON.stringify(header) : "",
          merged.changed ? JSON.stringify(merged.items) : "",
          String(req.baseRev),
        ]
      )) as string[];

      switch (res?.[0]) {
        case "ok": {
          const rev = Number(res[1]);
          const runHeader = header ?? snap.env!.header;
          return {
            status: merged.changed ? "saved" : "unchanged",
            rev,
            run: { ...runHeader, rev },
            staleIgnored: merged.staleIgnored,
            conflicts: merged.conflicts,
          };
        }
        case "conflict":
          await sleep(20 + Math.random() * 80);
          continue;
        case "gone":
          throw historyErrors.gone();
        case "expired":
          throw historyErrors.expired();
        case "mismatch":
          throw historyErrors.forbidden();
        default:
          console.error("[history] commit script returned unexpected result:", res);
          throw historyErrors.corrupt();
      }
    }
    throw historyErrors.conflict();
  }

  /** 履歴1件(概要+写真結果)を取得する。削除済み・期限切れ・存在しない場合はnull */
  async getRun(runId: string): Promise<HistoryRunDetail | null> {
    if (!isValidRunIdFormat(runId)) throw historyErrors.invalidRunId();
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await this.readSnapshot(runId);
      if (snap.tomb || !snap.env) return null;
      if (snap.env.expiresAtMs <= this.now()) return null;
      if (snap.items === null) {
        await sleep(30);
        continue;
      }
      return { run: { ...snap.env.header, rev: snap.env.rev }, items: snap.items };
    }
    throw historyErrors.busy();
  }

  /** 一覧(新しい順)。保存期間内の範囲だけを読み、実体の無いものは除外してインデックスから外す */
  async listRuns(filter: ListFilter = {}): Promise<{ runs: HistoryRunSummary[]; hasMore: boolean }> {
    const now = this.now();
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
    const offset = Math.max(filter.offset ?? 0, 0);
    const idxKey = filter.propertyId && filter.companyId
      ? keys.idxProperty(filter.companyId, filter.propertyId)
      : filter.companyId
        ? keys.idxCompany(filter.companyId)
        : keys.idxAll();

    const cutoff = now - this.retentionMs;
    const since = filter.days ? now - filter.days * 24 * 60 * 60 * 1000 - 1 : cutoff;
    const min = Math.max(cutoff, since);

    const ids = (await this.redis.zrange(idxKey, "+inf", `(${min}`, {
      byScore: true,
      rev: true,
      offset,
      count: limit + 1,
    })) as string[];
    const page = ids.slice(0, limit);

    const runs: HistoryRunSummary[] = [];
    const stale: string[] = [];
    if (page.length > 0) {
      const [envs, tombs] = await Promise.all([
        this.redis.mget<(string | null)[]>(...page.map(keys.run)),
        this.redis.mget<(string | null)[]>(...page.map(keys.tomb)),
      ]);
      page.forEach((id, i) => {
        const env = envs[i] ? parseEnvelope(String(envs[i])) : null;
        if (!env || tombs[i] || env.expiresAtMs <= now) {
          stale.push(id);
          return;
        }
        runs.push({ ...env.header, rev: env.rev });
      });
    }
    if (stale.length > 0) {
      await this.redis.zrem(idxKey, ...stale).catch((e) => console.error("[history] index cleanup failed:", e));
    }
    await this.sweepIndexes().catch((e) => console.error("[history] index sweep failed:", e));
    return { runs, hasMore: ids.length > limit };
  }

  /**
   * インデックスの補修を少しずつ進める(一覧表示のたびに最大maxKeys件)。
   * 期限切れの整理と、期限が付いていないインデックスへの期限設定を行う。
   */
  async sweepIndexes(maxKeys = 20): Promise<number> {
    const cursor = (await this.redis.get<string>(keys.sweepCursor())) ?? "0";
    const [next, found] = await this.redis.scan(String(cursor), { match: "history:idx:*", count: 100 });
    let repaired = 0;
    for (const key of (found as string[]).slice(0, maxKeys)) {
      const r = await this.redis.eval(SWEEP_INDEX_SCRIPT, [key], [
        String(this.now() - this.retentionMs),
        String(this.retentionMs),
      ]);
      if (Number(r) === 2) repaired += 1;
    }
    await this.redis.set(keys.sweepCursor(), String(next), { px: 24 * 60 * 60 * 1000 });
    return repaired;
  }

  /** 履歴を削除する。削除済みの印を先に置くため、途中で止まっても復活しない */
  async deleteRun(runId: string): Promise<"deleted" | "already_deleted"> {
    if (!isValidRunIdFormat(runId)) throw historyErrors.invalidRunId();
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const [raw, tomb] = await Promise.all([
        this.redis.get<string>(keys.run(runId)),
        this.redis.exists(keys.tomb(runId)),
      ]);
      let env: Envelope | null = null;
      if (raw !== null && raw !== undefined) {
        env = parseEnvelope(String(raw));
        if (!env) throw historyErrors.corrupt();
      } else if (tomb === 0) {
        throw historyErrors.notFound();
      }
      const [mode, companyId, propertyId] = (env?.imm ?? "standard||").split("|");
      const target = normalizeTarget({
        mode: mode as HistoryTarget["mode"],
        companyId: companyId || undefined,
        propertyId: propertyId || undefined,
      });
      const res = (await this.redis.eval(
        DELETE_SCRIPT,
        [keys.run(runId), keys.tomb(runId), keys.items(runId, env?.rev ?? 0), ...(env ? indexKeysFor(target) : [keys.idxAll()])],
        [runId, String(env?.rev ?? 0), env?.imm ?? "", String(this.failAt.delete ?? 0)]
      )) as string[];
      switch (res?.[0]) {
        case "deleted":
          console.log(`[history] deleted run ${runId} at ${new Date(this.now()).toISOString()}`);
          return "deleted";
        case "gone":
          return "already_deleted";
        case "notfound":
          throw historyErrors.notFound();
        case "conflict":
          await sleep(20 + Math.random() * 80);
          continue;
        default:
          console.error("[history] delete script returned unexpected result:", res);
          throw historyErrors.corrupt();
      }
    }
    throw historyErrors.conflict();
  }
}

/** 本番用: 環境変数からストアを作る。Redis・AUTH_SECRETが未設定なら履歴機能は無効 */
export function createHistoryStoreFromEnv(): HistoryStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const secret = process.env.AUTH_SECRET;
  if (!url || !token || !secret) throw historyErrors.disabled();
  return new HistoryStore({
    redis: createHistoryRedis(url, token),
    secret,
  });
}

/**
 * 履歴専用のRedisクライアント。値を自動でJSON解釈させない(概要・写真結果を
 * 文字列のまま扱い、型の取り違えを防ぐ)。既存の getRedisClient() とは独立。
 */
export function createHistoryRedis(url: string, token: string): Redis {
  return new Redis({
    url,
    token,
    automaticDeserialization: false,
    enableAutoPipelining: false,
    enableTelemetry: false,
  });
}

export { HistoryError };
