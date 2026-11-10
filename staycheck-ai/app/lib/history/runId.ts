import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { HistoryTarget } from "./types";

/**
 * 履歴ID(runId)の発行・検証。
 *
 * 形式: `{作成時刻(ミリ秒)の36進数}.{ランダム値16文字}.{署名22文字}`
 * 署名 = HMAC-SHA256(AUTH_SECRET, 用途ラベル | 作成時刻 | ランダム値 | モード | 会社ID | 物件ID)
 *
 * - 期限の判断は「Redisにデータが残っているか」ではなく、runIdに含まれる
 *   作成時刻で行う。期限切れでデータが消えたrunIdを初回保存と誤認して
 *   履歴が復活することを防ぐため。
 * - 署名に対象(モード・会社・物件)を含めるため、別の会社・物件の結果を
 *   同じrunIdへ書き込むことはできない。
 * - 閲覧・削除では署名を検証せず、形式のみ検査する(AUTH_SECRETを変更しても
 *   既存履歴を閲覧・削除できるようにするため)。
 */

/** 保存期間: 180日 */
export const HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/** 期限直前の保存を拒否する余裕(アプリとRedisの時計のずれを吸収する) */
export const HISTORY_WRITE_MARGIN_MS = 10 * 60 * 1000;
/** 未来の作成時刻として許容するずれ */
export const HISTORY_FUTURE_SKEW_MS = 5 * 60 * 1000;

const SIGNATURE_LABEL = "staycheck-history-run-v1";
export const RUN_ID_PATTERN = /^[0-9a-z]{8,9}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/;
export const TARGET_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidRunIdFormat(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID_PATTERN.test(runId);
}

/** 対象の組み合わせが正しいかを検査する(標準=ID無し / 会社=会社IDのみ / 物件=両方) */
export function isValidTarget(target: unknown): target is HistoryTarget {
  if (!target || typeof target !== "object") return false;
  const t = target as Record<string, unknown>;
  const cidOk = typeof t.companyId === "string" && TARGET_ID_PATTERN.test(t.companyId);
  const pidOk = typeof t.propertyId === "string" && TARGET_ID_PATTERN.test(t.propertyId);
  const cidAbsent = t.companyId === undefined || t.companyId === null || t.companyId === "";
  const pidAbsent = t.propertyId === undefined || t.propertyId === null || t.propertyId === "";
  switch (t.mode) {
    case "standard":
      return cidAbsent && pidAbsent;
    case "company":
      return cidOk && pidAbsent;
    case "property":
      return cidOk && pidOk;
    default:
      return false;
  }
}

/** 余計な値を落とした、正規化済みの対象を返す */
export function normalizeTarget(target: HistoryTarget): HistoryTarget {
  if (target.mode === "standard") return { mode: "standard" };
  if (target.mode === "company") return { mode: "company", companyId: target.companyId };
  return { mode: "property", companyId: target.companyId, propertyId: target.propertyId };
}

/** Redis側で照合する「変更不可項目」の文字列 */
export function targetFingerprint(target: HistoryTarget): string {
  const t = normalizeTarget(target);
  return `${t.mode}|${t.companyId ?? ""}|${t.propertyId ?? ""}`;
}

function sign(secret: string, ts36: string, nonce: string, target: HistoryTarget): string {
  const payload = [SIGNATURE_LABEL, ts36, nonce, targetFingerprint(target)].join("|");
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
}

export function issueRunId(target: HistoryTarget, secret: string, nowMs: number): string {
  const ts36 = Math.floor(nowMs).toString(36);
  const nonce = randomBytes(12).toString("base64url"); // 16文字
  return `${ts36}.${nonce}.${sign(secret, ts36, nonce, target)}`;
}

export function runIdCreatedAtMs(runId: string): number {
  return parseInt(runId.split(".")[0], 36);
}

/** 署名を検証する(形式が不正・署名不一致ならfalse) */
export function verifyRunId(runId: string, target: HistoryTarget, secret: string): boolean {
  if (!isValidRunIdFormat(runId) || !isValidTarget(target)) return false;
  const [ts36, nonce, sig] = runId.split(".");
  const expected = Buffer.from(sign(secret, ts36, nonce, target));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface RunTimes {
  createdAtMs: number;
  expiresAtMs: number;
  /** この時刻以降は保存を受け付けない */
  writeDeadlineMs: number;
}

export function runTimes(
  runId: string,
  retentionMs = HISTORY_RETENTION_MS,
  marginMs = HISTORY_WRITE_MARGIN_MS
): RunTimes {
  const createdAtMs = runIdCreatedAtMs(runId);
  const expiresAtMs = createdAtMs + retentionMs;
  return { createdAtMs, expiresAtMs, writeDeadlineMs: expiresAtMs - marginMs };
}
