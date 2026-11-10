import { NextRequest } from "next/server";
import { guardRequest, jsonResponse } from "@/app/lib/apiGuard";
import { historyErrors } from "@/app/lib/history/errors";
import { historyErrorResponse } from "@/app/lib/history/http";
import { TARGET_ID_PATTERN } from "@/app/lib/history/runId";
import { createHistoryStoreFromEnv } from "@/app/lib/history/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = new Set([7, 30]);

function parseIntParam(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,6}$/.test(value)) throw historyErrors.invalid("ページ指定が正しくありません。");
  const n = Number(value);
  if (n < min || n > max) throw historyErrors.invalid("ページ指定が正しくありません。");
  return n;
}

/** 履歴一覧(新しい順・20件ずつ) */
export async function GET(req: NextRequest) {
  const guard = await guardRequest(req);
  if (!guard.ok) return guard.response;
  try {
    const p = req.nextUrl.searchParams;
    const companyId = p.get("companyId") || undefined;
    const propertyId = p.get("propertyId") || undefined;
    if (companyId && !TARGET_ID_PATTERN.test(companyId)) throw historyErrors.invalid("会社IDの形式が正しくありません。");
    if (propertyId && (!companyId || !TARGET_ID_PATTERN.test(propertyId))) {
      throw historyErrors.invalid("物件IDの形式が正しくありません。");
    }
    const daysRaw = p.get("days");
    const days = daysRaw ? Number(daysRaw) : undefined;
    if (days !== undefined && !ALLOWED_DAYS.has(days)) throw historyErrors.invalid("期間の指定が正しくありません。");
    const offset = parseIntParam(p.get("offset"), 0, 100000, 0);
    const limit = parseIntParam(p.get("limit"), 1, 50, 20);

    const store = createHistoryStoreFromEnv();
    const result = await store.listRuns({ companyId, propertyId, days, offset, limit });
    return jsonResponse(result);
  } catch (err) {
    return historyErrorResponse(err);
  }
}
