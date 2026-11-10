import { Sidebar } from "@/app/components/Sidebar";

/**
 * ログイン後の画面(チェック・履歴・物件管理・設定)にだけ適用されるレイアウト。
 * app/login/page.tsx はこのグループの外にあるため、影響を受けない。
 *
 * PC幅: サイドバーを左に固定表示。
 * スマホ幅: サイドバーを上部の横並びナビゲーションとして表示。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col sm:flex-row">
      <Sidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
