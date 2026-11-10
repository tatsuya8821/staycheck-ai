import { PageHeader, PAGE_CONTAINER_CLASS } from "@/app/components/PageHeader";
import { AppInfoSection } from "@/app/components/AppInfoSection";
import { APP_NAME } from "@/app/lib/appInfo";

/**
 * 「アプリ情報」画面(v0.4.2〜。URLは従来どおり /settings)。
 *
 * 将来、設定機能を追加する場合は、この画面に設定用のセクションを追加するか、
 * サイドバーの表示名を「設定」に戻して、アプリ情報を1つのセクションとして残す想定。
 * (アプリ情報は AppInfoSection に分けてあるため、どちらの形にもそのまま使える)
 */
export default function SettingsPage() {
  return (
    <main className={PAGE_CONTAINER_CLASS}>
      <PageHeader title="アプリ情報" description={`${APP_NAME}の概要と、データの扱いについて`} />
      <AppInfoSection />
    </main>
  );
}
