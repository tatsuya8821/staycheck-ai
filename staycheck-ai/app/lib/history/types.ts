import type { CheckItem, Judgment, PhotoCategory, TokenUsage } from "@/app/types";

/**
 * 判定履歴(v0.4.0〜)の型定義。
 *
 * 保存方針(承認済み設計):
 * - 写真そのもの・DriveファイルID・エラーの生文面・物件ルール本文・プロンプト・
 *   OpenAIの生応答・Cookie/IP/OAuthトークンは保存しない。
 * - エラーは HistoryErrorCode の分類のみ保存し、表示文言は固定にする。
 * - 写真ごとに「判定世代番号(gen)」を持ち、古い保存リクエストが新しい再判定結果を
 *   上書きしないようにする。
 */

export type HistoryMode = "standard" | "company" | "property";

/** 履歴の対象(runIdの署名に含まれ、後から変更できない) */
export interface HistoryTarget {
  mode: HistoryMode;
  companyId?: string;
  propertyId?: string;
}

export const HISTORY_ERROR_CODES = [
  "rate_limited",
  "quota_exceeded",
  "drive_fetch_failed",
  "rule_error",
  "judge_failed",
] as const;
export type HistoryErrorCode = (typeof HISTORY_ERROR_CODES)[number];

/** エラー分類ごとの固定表示文言(生のエラー文面は保存・表示しない) */
export const HISTORY_ERROR_LABELS: Record<HistoryErrorCode, string> = {
  rate_limited: "レート制限により判定できませんでした",
  quota_exceeded: "APIのクレジット残高不足の可能性があります",
  drive_fetch_failed: "Google Driveから写真を取得できませんでした",
  rule_error: "会社・物件のルール指定に問題がありました",
  judge_failed: "判定に失敗しました",
};

/** 写真1枚分の履歴 */
export interface HistoryItem {
  /** チェック画面上の写真ID(UUID)。同じ写真の再判定は同じphotoKeyで上書きする */
  photoKey: string;
  /** 判定世代番号(同じ写真を判定し直すたびに1ずつ増える。1始まり) */
  gen: number;
  fileName: string;
  source: "local" | "drive";
  category: PhotoCategory;
  /** 「物件名」入力欄の表示ラベル */
  propertyName: string;
  status: "done" | "error";
  judgment?: Judgment;
  summary?: string;
  checks?: CheckItem[];
  usage?: TokenUsage;
  /** 保存時点の単価で計算した費用(USD) */
  costUsd?: number;
  errorCode?: HistoryErrorCode;
  /** 判定(またはエラー)が確定した日時(ISO 8601) */
  judgedAt: string;
}

/** 直近のバッチの診断情報(任意) */
export interface HistoryBatchStats {
  elapsedMs: number;
  rateLimitHits: number;
  retries: number;
  rateLimitFailures: number;
}

/** 履歴1件の概要 */
export interface HistoryHeader {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  mode: HistoryMode;
  companyId?: string;
  companyLabel?: string;
  propertyId?: string;
  propertyLabel?: string;
  /** 物件ルールの指紋(本文は保存しない) */
  ruleFingerprint?: { propertyUpdatedAt: string; ruleTextSha256: string };
  photoCount: number;
  counts: Record<Judgment, number>;
  errorCount: number;
  usage: TokenUsage;
  costUsd: number;
  pricing: { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number };
  model: string;
  appVersion: string;
  lastBatch?: HistoryBatchStats;
}

/** APIが返す概要(更新番号付き) */
export interface HistoryRunSummary extends HistoryHeader {
  rev: number;
}

export interface HistoryRunDetail {
  run: HistoryRunSummary;
  items: HistoryItem[];
}

/** 1件の履歴に含められる写真の上限(チェック画面のMAX_PHOTOSと同じ値) */
export const HISTORY_MAX_ITEMS = 300;
