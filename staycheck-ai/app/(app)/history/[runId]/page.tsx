"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { JUDGMENT_PRIORITY, type Judgment } from "@/app/types";
import { JUDGMENT_STYLE } from "@/app/components/JudgmentBadges";
import { HistoryResultRow } from "@/app/components/HistoryResultRow";
import type { HistoryRunDetail } from "@/app/lib/history/types";
import { formatDateTime, formatTarget } from "@/app/lib/history/format";
import { PAGE_CONTAINER_CLASS } from "@/app/components/PageHeader";
import { APP_NAME } from "@/app/lib/appInfo";

const ORDER: Judgment[] = ["◎ 良好", "○ 基準内", "◇ 確認推奨", "△ 要調整"];

export default function HistoryDetailPage() {
  const params = useParams<{ runId: string }>();
  const router = useRouter();
  const runId = decodeURIComponent(params.runId);
  const [detail, setDetail] = useState<HistoryRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetch(`/api/history/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "履歴を読み込めませんでした。");
        setDetail(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "履歴を読み込めませんでした。"));
  }, [runId]);

  /** △要調整・◇確認推奨を上に、エラーは最後に並べる(チェック画面と同じ順序) */
  const sortedItems = useMemo(() => {
    if (!detail) return [];
    return detail.items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => {
        const pa = a.it.status === "done" && a.it.judgment ? JUDGMENT_PRIORITY[a.it.judgment] : 99;
        const pb = b.it.status === "done" && b.it.judgment ? JUDGMENT_PRIORITY[b.it.judgment] : 99;
        return pa - pb || a.i - b.i;
      })
      .map((x) => x.it);
  }, [detail]);

  const handleDelete = async () => {
    if (!window.confirm("この履歴を削除します。元に戻せません。よろしいですか?")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(runId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "削除できませんでした。");
      router.push("/history");
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除できませんでした。");
      setDeleting(false);
    }
  };

  const run = detail?.run;

  return (
    <main className={PAGE_CONTAINER_CLASS}>
      <Link href="/history" className="text-xs text-inkfaint underline decoration-dotted hover:text-ink">
        ← 履歴一覧へ戻る
      </Link>
      <p className="mt-4 font-mono text-xs tracking-widest text-inkfaint">{APP_NAME} / 履歴</p>
      <h1 className="mt-2 font-display text-2xl font-bold text-ink">{run ? formatTarget(run) : "履歴の詳細"}</h1>

      {error && (
        <div className="mt-6 rounded-xl border border-terracotta/30 bg-terracotta-soft p-4 text-sm text-terracotta" data-testid="history-error">
          {error}
        </div>
      )}
      {!detail && !error && <p className="mt-6 text-sm text-inkfaint">読み込み中…</p>}

      {run && (
        <>
          <section className="mt-6 rounded-2xl border border-hairline bg-surface p-5 shadow-card" data-testid="history-summary">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-[11px] text-inkfaint">作成日時</dt>
                <dd className="font-mono text-ink">{formatDateTime(run.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-inkfaint">最終更新</dt>
                <dd className="font-mono text-ink">{formatDateTime(run.updatedAt)}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-inkfaint">写真</dt>
                <dd className="text-ink">
                  {run.photoCount}枚{run.errorCount > 0 ? `(エラー${run.errorCount}枚)` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-inkfaint">費用(保存時点の単価)</dt>
                <dd className="font-mono text-ink">${run.costUsd.toFixed(4)}</dd>
              </div>
            </dl>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ORDER.map((j) => (
                <div key={j} className={`rounded-xl border p-3 ${JUDGMENT_STYLE[j].ring} ${JUDGMENT_STYLE[j].bg}`}>
                  <p className={`text-xs font-bold ${JUDGMENT_STYLE[j].text}`}>{j}</p>
                  <p className={`mt-1 font-display text-2xl font-bold ${JUDGMENT_STYLE[j].text}`} data-testid={`count-${j}`}>
                    {run.counts[j]}
                    <span className="ml-1 text-xs font-normal">枚</span>
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-inkfaint">
              モデル: {run.model} / アプリ: v{run.appVersion} / 保存期限: {formatDateTime(run.expiresAt)}
              {run.ruleFingerprint &&
                ` / 物件ルール: ${formatDateTime(run.ruleFingerprint.propertyUpdatedAt)}更新版(指紋 ${run.ruleFingerprint.ruleTextSha256})`}
            </p>
          </section>

          <section className="mt-6 space-y-2" data-testid="history-items">
            {sortedItems.map((it) => (
              <HistoryResultRow key={it.photoKey} item={it} />
            ))}
          </section>

          <div className="mt-8 flex justify-end">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg border border-terracotta/40 px-4 py-2 text-sm text-terracotta hover:bg-terracotta-soft disabled:opacity-40"
            >
              {deleting ? "削除中…" : "この履歴を削除"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
