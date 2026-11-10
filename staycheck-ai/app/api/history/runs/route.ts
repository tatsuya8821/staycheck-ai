import { NextRequest } from "next/server";
import { guardRequest, jsonResponse } from "@/app/lib/apiGuard";
import { historyErrorResponse } from "@/app/lib/history/http";
import { createHistoryStoreFromEnv } from "@/app/lib/history/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 履歴IDの発行。判定処理とは無関係で、最初の履歴保存の直前に画面から呼ばれる。
 * この時点ではRedisへ履歴を書き込まない(会社・物件モードでは存在確認のみ行う)。
 */
export async function POST(req: NextRequest) {
  const guard = await guardRequest(req, { mutating: true, readJsonBody: true, maxBodyBytes: 4096 });
  if (!guard.ok) return guard.response;
  try {
    const store = createHistoryStoreFromEnv();
    const body = (guard.body ?? {}) as { target?: unknown };
    const result = await store.issueRun(body.target as never);
    return jsonResponse(result, 201);
  } catch (err) {
    return historyErrorResponse(err);
  }
}
