"use client";

import Link from "next/link";
import type { SaverStatus } from "@/app/lib/history/client";

/** チェック画面に出す、履歴の保存状況(判定結果とは独立した小さな表示) */
export function HistorySaveNotice({ status, onRetry }: { status: SaverStatus; onRetry: () => void }) {
  if (status.state === "idle") return null;
  const base = "mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs";

  if (status.state === "saving") {
    return (
      <p className={`${base} border-hairline bg-mist text-inkfaint`} data-testid="history-status" data-state="saving">
        履歴を保存中…
      </p>
    );
  }
  if (status.state === "saved") {
    return (
      <p className={`${base} border-teal/30 bg-teal-soft text-teal`} data-testid="history-status" data-state="saved">
        履歴に保存しました({status.photoCount}枚)
        <Link href="/history" className="underline decoration-dotted hover:opacity-80">
          履歴を見る
        </Link>
      </p>
    );
  }
  if (status.state === "disabled") {
    return (
      <p className={`${base} border-hairline bg-mist text-inkfaint`} data-testid="history-status" data-state="disabled">
        履歴機能は無効です(保存先が設定されていません)。判定はこれまで通り利用できます。
      </p>
    );
  }
  return (
    <div className={`${base} border-terracotta/30 bg-terracotta-soft text-terracotta`} data-testid="history-status" data-state="failed">
      <span>{status.message} 判定結果には影響ありません。</span>
      {status.retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-terracotta/40 bg-surface px-2.5 py-1 font-bold hover:opacity-80"
        >
          再送
        </button>
      )}
    </div>
  );
}
