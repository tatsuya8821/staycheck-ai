/**
 * v0.4.3.1: 公開デモに向けた設定(アプリの処理は変更しない)
 * - images.unoptimized: 画像最適化(/_next/image)を停止する。本アプリは next/image を使っておらず、
 *   Next.js 14 の画像最適化に関する既知の脆弱性の入口を閉じるため(docs/KNOWN_ISSUES.md KI-001)
 * - poweredByHeader: 応答から「X-Powered-By: Next.js」を外す
 * - headers(): ブラウザ向けの基本的なセキュリティヘッダー
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
