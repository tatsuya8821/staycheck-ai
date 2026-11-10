"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { APP_DESCRIPTION_JA, APP_NAME } from "@/app/lib/appInfo";

/**
 * サイドバー(ナビゲーションの外枠)。
 *
 * v0.1.0時点では「チェック」画面(既存のapp/(app)/page.tsx)だけが実際に
 * 機能する。履歴・物件管理・設定は、この段階では中身のない準備中ページに
 * リンクするだけの器として用意している(段階的に中身を実装していく想定)。
 * v0.3.0で物件管理、v0.4.0で履歴を実装済み。v0.4.2で「設定」を「アプリ情報」画面に変更(URLは /settings のまま)。
 *
 * スマホ幅(640px未満, v0.4.3〜): 1段目にアプリ名、2段目にメニュー4項目を均等幅で並べ、
 * 360px幅でもすべて画面内に収める(文字14px・タップ領域の高さ44px以上)。
 * PC幅(640px以上)の表示は従来どおり。
 *
 * 判定ロジック・API呼び出し・アップロード処理には一切関与しない、
 * 純粋な画面構造(ナビゲーション)のコンポーネント。
 */

const NAV_ITEMS = [
  { href: "/", label: "チェック", ready: true },
  { href: "/history", label: "履歴", ready: true },
  { href: "/properties", label: "物件管理", ready: true },
  { href: "/settings", label: "アプリ情報", ready: true },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-hairline bg-surface sm:h-screen sm:w-56 sm:border-b-0 sm:border-r">
      <div className="px-4 pb-2 pt-3 sm:px-5 sm:py-6">
        <p className="font-display text-base font-bold text-ink">{APP_NAME}</p>
        <p className="mt-0.5 text-[11px] text-inkfaint">{APP_DESCRIPTION_JA}</p>
      </div>

      <nav className="grid grid-cols-4 gap-1 px-2 pb-2 sm:flex sm:flex-1 sm:flex-col sm:px-3 sm:pb-6">
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-1 py-2 text-sm font-medium transition-colors sm:min-h-0 sm:justify-between sm:px-3 sm:py-2.5 ${
                isActive
                  ? "bg-teal-soft text-teal"
                  : "text-inkfaint hover:bg-mist hover:text-ink"
              }`}
            >
              <span>{item.label}</span>
              {!item.ready && (
                <span className="hidden rounded-full bg-mist px-1.5 py-0.5 text-[10px] text-inkfaint sm:inline">
                  準備中
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
