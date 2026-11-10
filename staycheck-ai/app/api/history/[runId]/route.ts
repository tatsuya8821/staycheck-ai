import { NextRequest } from "next/server";
import { guardRequest, jsonResponse } from "@/app/lib/apiGuard";
import { historyErrors } from "@/app/lib/history/errors";
import { historyErrorResponse } from "@/app/lib/history/http";
import { isValidRunIdFormat } from "@/app/lib/history/runId";
import { sanitizeSaveRequest } from "@/app/lib/history/sanitize";
import { createHistoryStoreFromEnv } from "@/app/lib/history/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { runId: string } };

/** 形式が不正なIDは、Redisへ一切アクセスせずに拒否する */
function checkRunId(runId: string) {
  if (!isValidRunIdFormat(runId)) throw historyErrors.invalidRunId();
}

/** 履歴の詳細(概要+写真結果) */
export async function GET(req: NextRequest, { params }: Ctx) {
  const guard = await guardRequest(req);
  if (!guard.ok) return guard.response;
  try {
    checkRunId(params.runId);
    const detail = await createHistoryStoreFromEnv().getRun(params.runId);
    if (!detail) throw historyErrors.notFound();
    return jsonResponse(detail);
  } catch (err) {
    return historyErrorResponse(err);
  }
}

/** 写真結果の保存(同じ内容を何度送っても結果は同じ) */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await guardRequest(req, { mutating: true, readJsonBody: true });
  if (!guard.ok) return guard.response;
  try {
    checkRunId(params.runId);
    const request = sanitizeSaveRequest(guard.body);
    const result = await createHistoryStoreFromEnv().saveRun(params.runId, request);
    return jsonResponse({
      status: result.status,
      rev: result.rev,
      staleIgnored: result.staleIgnored,
      conflicts: result.conflicts,
      photoCount: result.run.photoCount,
    });
  } catch (err) {
    return historyErrorResponse(err);
  }
}

/** 履歴の削除 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await guardRequest(req, { mutating: true });
  if (!guard.ok) return guard.response;
  try {
    checkRunId(params.runId);
    const status = await createHistoryStoreFromEnv().deleteRun(params.runId);
    return jsonResponse({ status });
  } catch (err) {
    return historyErrorResponse(err);
  }
}
