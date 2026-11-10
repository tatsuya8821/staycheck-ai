"use client";

import { PHOTO_CATEGORY_LABELS } from "@/app/types";
import { JUDGMENT_STYLE } from "./JudgmentBadges";
import { HISTORY_ERROR_LABELS, type HistoryItem } from "@/app/lib/history/types";

/**
 * 履歴詳細の結果1行(写真は保存していないため、ファイル名と判定内容のみ表示する)。
 * v0.4.3: 区切りのない長い要約・物件名でも画面からはみ出さないよう、行全体で折り返しを許可。
 */
export function HistoryResultRow({ item }: { item: HistoryItem }) {
  if (item.status === "error" || !item.judgment) {
    return (
      <div className="rounded-xl border border-hairline bg-mist p-3 [overflow-wrap:anywhere]" data-testid="history-item" data-status="error">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-display text-sm font-bold text-inkfaint">エラー</span>
          <span className="break-all font-mono text-[11px] text-inkfaint">{item.fileName}</span>
        </div>
        <p className="mt-1 text-sm text-ink">{HISTORY_ERROR_LABELS[item.errorCode ?? "judge_failed"]}</p>
      </div>
    );
  }
  const style = JUDGMENT_STYLE[item.judgment];
  const ngChecks = (item.checks ?? []).filter((c) => !c.ok);
  return (
    <div className={`rounded-xl border bg-surface p-3 [overflow-wrap:anywhere] ${style.ring}`} data-testid="history-item" data-judgment={item.judgment}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={`font-display text-sm font-bold ${style.text}`}>
          {item.judgment}
          <span className="ml-2 text-[11px] font-normal text-inkfaint">
            {item.propertyName || "(物件名未入力)"}・{PHOTO_CATEGORY_LABELS[item.category] ?? item.category}
          </span>
        </span>
        <span className="break-all font-mono text-[11px] text-inkfaint">{item.fileName}</span>
      </div>
      {item.summary && <p className="mt-1 text-sm text-ink">{item.summary}</p>}
      {ngChecks.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-inkfaint">
          {ngChecks.map((c, i) => (
            <li key={i}>・{c.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
