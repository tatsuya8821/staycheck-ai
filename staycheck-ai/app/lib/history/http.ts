import { errorResponse } from "@/app/lib/apiGuard";
import { HistoryError } from "./errors";

/** 履歴APIの共通エラー処理。生のエラー文はログにだけ出し、レスポンスは固定文言にする */
export function historyErrorResponse(err: unknown) {
  if (err instanceof HistoryError) {
    if (err.status >= 500) console.error(`[history] ${err.code}`);
    return errorResponse(err.status, err.code, err.message);
  }
  console.error("[history] unexpected error:", err);
  return errorResponse(500, "internal_error", "履歴の処理中にエラーが発生しました。時間をおいて再度お試しください。");
}
