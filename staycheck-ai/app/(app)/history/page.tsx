"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Judgment } from "@/app/types";
import { JUDGMENT_STYLE } from "@/app/components/JudgmentBadges";
import type { HistoryRunSummary } from "@/app/lib/history/types";
import { formatDateTime, formatTarget } from "@/app/lib/history/format";
import { PageHeader, PAGE_CONTAINER_CLASS } from "@/app/components/PageHeader";
import { HISTORY_RETENTION_DAYS } from "@/app/lib/appInfo";

const ORDER: Judgment[] = ["△ 要調整", "◇ 確認推奨", "○ 基準内", "◎ 良好"];
const PAGE_SIZE = 20;

type Company = { companyId: string; companyLabel: string };
type Property = { propertyId: string; propertyLabel: string };

export default function HistoryPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [days, setDays] = useState("");
  const [runs, setRuns] = useState<HistoryRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; disabled: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies ?? []))
      .catch(() => setCompanies([]));
  }, []);

  useEffect(() => {
    if (!companyId) {
      setProperties([]);
      return;
    }
    fetch(`/api/companies/${encodeURIComponent(companyId)}/properties`)
      .then((r) => r.json())
      .then((d) => setProperties(d.properties ?? []))
      .catch(() => setProperties([]));
  }, [companyId]);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
      if (companyId) q.set("companyId", companyId);
      if (companyId && propertyId) q.set("propertyId", propertyId);
      if (days) q.set("days", days);
      try {
        const res = await fetch(`/api/history?${q.toString()}`, { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError({
            message: data?.error ?? "履歴を読み込めませんでした。",
            disabled: data?.code === "history_disabled",
          });
          if (offset === 0) setRuns([]);
          setHasMore(false);
          return;
        }
        setRuns((prev) => (offset === 0 ? data.runs : [...prev, ...data.runs]));
        setHasMore(Boolean(data.hasMore));
      } catch {
        setError({ message: "通信エラーにより履歴を読み込めませんでした。", disabled: false });
      } finally {
        setLoading(false);
      }
    },
    [companyId, propertyId, days]
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const selectClass =
    "mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-teal disabled:opacity-50";

  return (
    <main className={PAGE_CONTAINER_CLASS}>
      <PageHeader
        title="履歴"
        description={`判定の結果を、チェック作業ごとに保存しています。保存期間は${HISTORY_RETENTION_DAYS}日です(写真そのものは保存していません)。`}
      />

      <section className="grid grid-cols-1 gap-3 rounded-2xl border border-hairline bg-surface p-4 shadow-card sm:grid-cols-3">
        <div>
          <label className="block text-[11px] text-inkfaint" htmlFor="filter-company">会社</label>
          <select
            id="filter-company"
            value={companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
              setPropertyId("");
            }}
            className={selectClass}
          >
            <option value="">すべて</option>
            {companies.map((c) => (
              <option key={c.companyId} value={c.companyId}>
                {c.companyLabel}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-inkfaint" htmlFor="filter-property">物件</label>
          <select
            id="filter-property"
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            disabled={!companyId}
            className={selectClass}
          >
            <option value="">すべて</option>
            {properties.map((p) => (
              <option key={p.propertyId} value={p.propertyId}>
                {p.propertyLabel}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-inkfaint" htmlFor="filter-days">期間</label>
          <select id="filter-days" value={days} onChange={(e) => setDays(e.target.value)} className={selectClass}>
            <option value="">保存期間すべて({HISTORY_RETENTION_DAYS}日)</option>
            <option value="30">直近30日</option>
            <option value="7">直近7日</option>
          </select>
        </div>
      </section>

      {error && (
        <div
          className={`mt-6 rounded-xl border p-4 text-sm ${
            error.disabled ? "border-hairline bg-mist text-inkfaint" : "border-terracotta/30 bg-terracotta-soft text-terracotta"
          }`}
          data-testid="history-error"
        >
          {error.message}
        </div>
      )}

      <section className="mt-6 space-y-3" data-testid="history-list">
        {runs.map((run) => (
          <Link
            key={run.runId}
            href={`/history/${encodeURIComponent(run.runId)}`}
            className="block rounded-2xl border border-hairline bg-surface p-4 shadow-card transition-colors hover:bg-mist"
            data-testid="history-row"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-display text-sm font-bold text-ink">{formatTarget(run)}</span>
              <span className="font-mono text-xs text-inkfaint">{formatDateTime(run.createdAt)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {ORDER.map((j) => (
                <span
                  key={j}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${JUDGMENT_STYLE[j].ring} ${JUDGMENT_STYLE[j].bg} ${JUDGMENT_STYLE[j].text}`}
                >
                  {j.split(" ")[0]} {run.counts[j]}
                </span>
              ))}
              {run.errorCount > 0 && (
                <span className="rounded-full border border-hairline bg-mist px-2.5 py-0.5 text-xs font-bold text-inkfaint">
                  エラー {run.errorCount}
                </span>
              )}
              <span className="ml-auto text-xs text-inkfaint">
                {run.photoCount}枚・${run.costUsd.toFixed(4)}
              </span>
            </div>
          </Link>
        ))}

        {!loading && !error && runs.length === 0 && (
          <div className="rounded-2xl border border-hairline bg-surface p-10 text-center text-sm text-inkfaint shadow-card">
            まだ履歴はありません。チェック画面で判定すると、ここに保存されます。
          </div>
        )}
        {loading && <p className="text-center text-sm text-inkfaint">読み込み中…</p>}
        {hasMore && !loading && (
          <button
            type="button"
            onClick={() => load(runs.length)}
            className="w-full rounded-xl border border-hairline bg-surface py-2.5 text-sm text-ink hover:bg-mist"
          >
            もっと見る
          </button>
        )}
      </section>

      <p className="mt-8 text-[11px] leading-relaxed text-inkfaint">
        ※ 現在は共有パスワードでのログインのため、ログインした全員が、すべての会社・物件の履歴を閲覧・削除できます。
      </p>
    </main>
  );
}
