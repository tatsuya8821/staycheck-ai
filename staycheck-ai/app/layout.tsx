import type { Metadata } from "next";
import { APP_DESCRIPTION_JA, APP_NAME, APP_SUBTITLE } from "@/app/lib/appInfo";
import "./globals.css";

export const metadata: Metadata = {
  title: `${APP_NAME} | ${APP_DESCRIPTION_JA}`,
  description: APP_SUBTITLE,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
