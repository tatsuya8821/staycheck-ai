/**
 * 履歴機能のエラー。APIはここで定義した「固定の文言とコード」だけを返し、
 * Redisなどの生のエラー文はレスポンスに含めない(サーバーログにのみ出す)。
 */
export class HistoryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const historyErrors = {
  disabled: () =>
    new HistoryError(503, "history_disabled", "履歴の保存先(Upstash Redis)が設定されていないため、履歴機能は無効です。"),
  invalid: (detail = "リクエストの内容が正しくありません。") => new HistoryError(400, "invalid_request", detail),
  invalidRunId: () => new HistoryError(400, "invalid_run_id", "履歴IDの形式が正しくありません。"),
  forbidden: () => new HistoryError(403, "forbidden", "この履歴には保存できません(対象が一致しません)。"),
  notFound: () => new HistoryError(404, "not_found", "指定された履歴は見つかりません。"),
  conflict: () => new HistoryError(409, "conflict", "同じ履歴への保存が重なりました。少し待ってから再送してください。"),
  gone: () => new HistoryError(410, "gone", "この履歴は削除済み、または保存期間(180日)を過ぎています。"),
  expired: () => new HistoryError(410, "expired", "この履歴は保存期間(180日)を過ぎているため、更新できません。"),
  tooManyItems: () => new HistoryError(422, "too_many_items", "1件の履歴に保存できる写真は300枚までです。"),
  targetNotFound: () => new HistoryError(404, "target_not_found", "指定された会社・物件は登録されていません。"),
  corrupt: () => new HistoryError(500, "storage_inconsistent", "履歴データを安全に更新できませんでした。管理者に確認してください。"),
  busy: () => new HistoryError(503, "busy", "履歴を読み込めませんでした。時間をおいて再度お試しください。"),
};
