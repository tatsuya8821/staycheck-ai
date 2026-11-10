import { APP_INFO_ITEMS } from "@/app/lib/appInfo";

/**
 * アプリ情報の一覧(表示専用)。
 * 表示するのは app/lib/appInfo.ts の固定の文章だけで、環境変数・APIキー・認証情報・
 * データベース名・内部URLなどは一切読み込まない。
 */
export function AppInfoSection() {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-5 shadow-card sm:p-6" data-testid="app-info">
      <dl className="divide-y divide-hairline">
        {APP_INFO_ITEMS.map((item) => (
          <div key={item.label} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4" data-testid="app-info-item">
            <dt className="text-xs font-bold text-inkfaint sm:text-sm">{item.label}</dt>
            <dd className="text-sm text-ink">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
