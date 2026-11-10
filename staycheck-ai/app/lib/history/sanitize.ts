import { PHOTO_CATEGORY_LABELS, type CheckItem, type Judgment, type PhotoCategory, type TokenUsage } from "@/app/types";
import { isValidTarget, normalizeTarget } from "./runId";
import { historyErrors } from "./errors";
import {
  HISTORY_ERROR_CODES,
  HISTORY_MAX_ITEMS,
  type HistoryBatchStats,
  type HistoryErrorCode,
  type HistoryItem,
  type HistoryTarget,
} from "./types";

/**
 * 保存リクエストの検査と正規化。
 * - 許可した項目だけで新しいオブジェクトを組み立てる(それ以外の項目は捨てる)。
 *   errorMsg・driveFileId・ruleText等が送られてきても保存されない。
 * - 文字列は制御文字を除き、上限文字数で切り詰める。
 */

export const LIMITS = {
  fileName: 120,
  propertyName: 60,
  summary: 500,
  checkLabel: 100,
  checks: 20,
  tokens: 10_000_000,
  gen: 1_000_000,
} as const;

const JUDGMENTS: readonly Judgment[] = ["◎ 良好", "○ 基準内", "◇ 確認推奨", "△ 要調整"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // 制御文字(改行・タブ含む)は空白に置き換え、コードポイント単位で切り詰める
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return Array.from(cleaned).slice(0, max).join("");
}

function intInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function sanitizeUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const inputTokens = intInRange(u.inputTokens, 0, LIMITS.tokens);
  const outputTokens = intInRange(u.outputTokens, 0, LIMITS.tokens);
  const totalTokens = intInRange(u.totalTokens, 0, LIMITS.tokens * 2);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return undefined;
  const cachedTokens = intInRange(u.cachedTokens ?? 0, 0, LIMITS.tokens) ?? 0;
  return { inputTokens, outputTokens, totalTokens, cachedTokens: Math.min(cachedTokens, inputTokens) };
}

function sanitizeChecks(value: unknown): CheckItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, LIMITS.checks)
    .filter((c) => c && typeof c === "object" && typeof (c as CheckItem).ok === "boolean")
    .map((c) => ({ label: cleanText((c as CheckItem).label, LIMITS.checkLabel), ok: (c as CheckItem).ok }));
}

/** 写真1枚分を検査する。不正な場合は理由を投げる */
export function sanitizeItem(value: unknown): HistoryItem {
  if (!value || typeof value !== "object") throw historyErrors.invalid("写真の情報が正しくありません。");
  const v = value as Record<string, unknown>;

  if (typeof v.photoKey !== "string" || !UUID_PATTERN.test(v.photoKey)) {
    throw historyErrors.invalid("写真IDの形式が正しくありません。");
  }
  const gen = intInRange(v.gen, 1, LIMITS.gen);
  if (gen === null) throw historyErrors.invalid("判定世代番号が正しくありません。");
  if (v.source !== "local" && v.source !== "drive") throw historyErrors.invalid("写真の取り込み元が正しくありません。");
  if (typeof v.category !== "string" || !(v.category in PHOTO_CATEGORY_LABELS)) {
    throw historyErrors.invalid("写真カテゴリが正しくありません。");
  }
  const judgedAtMs = typeof v.judgedAt === "string" ? Date.parse(v.judgedAt) : NaN;
  if (!Number.isFinite(judgedAtMs)) throw historyErrors.invalid("判定日時が正しくありません。");

  const base: HistoryItem = {
    photoKey: v.photoKey,
    gen,
    fileName: cleanText(v.fileName, LIMITS.fileName) || "(不明なファイル)",
    source: v.source,
    category: v.category as PhotoCategory,
    propertyName: cleanText(v.propertyName, LIMITS.propertyName),
    status: "done",
    judgedAt: new Date(judgedAtMs).toISOString(),
  };

  if (v.status === "done") {
    if (typeof v.judgment !== "string" || !JUDGMENTS.includes(v.judgment as Judgment)) {
      throw historyErrors.invalid("判定結果が4段階のいずれでもありません。");
    }
    const usage = sanitizeUsage(v.usage);
    return {
      ...base,
      status: "done",
      judgment: v.judgment as Judgment,
      summary: cleanText(v.summary, LIMITS.summary),
      checks: sanitizeChecks(v.checks),
      ...(usage ? { usage } : {}),
    };
  }
  if (v.status === "error") {
    const errorCode: HistoryErrorCode = HISTORY_ERROR_CODES.includes(v.errorCode as HistoryErrorCode)
      ? (v.errorCode as HistoryErrorCode)
      : "judge_failed";
    return { ...base, status: "error", errorCode };
  }
  throw historyErrors.invalid("写真の状態が正しくありません。");
}

function sanitizeBatchStats(value: unknown): HistoryBatchStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const elapsedMs = intInRange(typeof v.elapsedMs === "number" ? Math.round(v.elapsedMs) : null, 0, 86_400_000);
  const rateLimitHits = intInRange(v.rateLimitHits, 0, 1_000_000);
  const retries = intInRange(v.retries, 0, 1_000_000);
  const rateLimitFailures = intInRange(v.rateLimitFailures, 0, 1_000_000);
  if (elapsedMs === null || rateLimitHits === null || retries === null || rateLimitFailures === null) return undefined;
  return { elapsedMs, rateLimitHits, retries, rateLimitFailures };
}

export interface SaveRequest {
  target: HistoryTarget;
  /** 画面側が最後に確認した更新番号(未保存なら0) */
  baseRev: number;
  items: HistoryItem[];
  batchStats?: HistoryBatchStats;
}

/** PUT /api/history/[runId] の本文を検査する */
export function sanitizeSaveRequest(body: unknown): SaveRequest {
  if (!body || typeof body !== "object") throw historyErrors.invalid();
  const b = body as Record<string, unknown>;
  if (!isValidTarget(b.target)) throw historyErrors.invalid("履歴の対象(モード・会社・物件)が正しくありません。");
  const baseRev = intInRange(b.baseRev ?? 0, 0, Number.MAX_SAFE_INTEGER);
  if (baseRev === null) throw historyErrors.invalid("更新番号が正しくありません。");
  if (!Array.isArray(b.items) || b.items.length === 0) throw historyErrors.invalid("保存する写真がありません。");
  if (b.items.length > HISTORY_MAX_ITEMS) throw historyErrors.tooManyItems();

  // 同じ写真が1回のリクエストに複数含まれる場合は、世代番号が最も大きいものを採用する
  const byKey = new Map<string, HistoryItem>();
  for (const raw of b.items) {
    const item = sanitizeItem(raw);
    const prev = byKey.get(item.photoKey);
    if (!prev || item.gen > prev.gen) byKey.set(item.photoKey, item);
  }

  return {
    target: normalizeTarget(b.target),
    baseRev,
    items: [...byKey.values()],
    batchStats: sanitizeBatchStats(b.batchStats),
  };
}
