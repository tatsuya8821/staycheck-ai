import type { ReactNode } from "react";
import { APP_NAME } from "@/app/lib/appInfo";

/**
 * 各画面で共通の外枠の幅・余白(v0.4.2〜)。
 * チェック・履歴・物件管理・アプリ情報の各画面で同じ値を使い、画面を移っても見え方がそろうようにする。
 */
export const PAGE_CONTAINER_CLASS = "mx-auto min-h-screen max-w-5xl px-4 py-8 sm:px-8 sm:py-10";

/** 各画面で共通の見出し(アプリ名+画面名+1行説明)。表示専用 */
export function PageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="font-mono text-xs tracking-widest text-inkfaint">{APP_NAME}</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-inkfaint">{description}</p>}
      </div>
      {right}
    </header>
  );
}
