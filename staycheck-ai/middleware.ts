import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "@/app/lib/auth";

/**
 * 共有パスワード認証のゲート。
 * 以下を除く全パスに適用される(matcher参照):
 * - /login (ログイン画面)
 * - /api/session/* (ログイン・ログアウトAPI自体)
 * - Next.jsの静的アセット(_next/static, _next/image, favicon.ico)
 *
 * 判定API(/api/judge)・Google Drive関連API(/api/google-drive/*)も
 * このミドルウェアの対象に含まれるため、未ログイン状態ではAPIも一切使えない。
 */

// ブラウザの直接ナビゲーションで使われる、Google OAuthの入口・コールバック。
// fetchで呼ぶAPIとは違い、未認証時はJSONではなく/loginへリダイレクトしたい。
const PAGE_LIKE_API_PATHS = ["/api/google-drive/auth", "/api/google-drive/callback"];

export async function middleware(req: NextRequest) {
  const authSecret = process.env.AUTH_SECRET;

  if (!authSecret) {
    // AUTH_SECRET未設定のまま公開してしまうと認証が機能しないため、
    // フェイルオープン(素通り)ではなく、はっきりしたエラーで止める。
    return new NextResponse(
      "認証設定が不足しています(AUTH_SECRETが未設定です)。管理者に確認してください。",
      { status: 503 }
    );
  }

  const cookieValue = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isValid = await verifySessionCookieValue(cookieValue, authSecret);

  if (isValid) {
    return NextResponse.next();
  }

  const pathname = req.nextUrl.pathname;
  const isPageLikeApi = PAGE_LIKE_API_PATHS.some((p) => pathname.startsWith(p));

  // 通常のAPI(fetchで呼ばれるもの)は、未認証ならJSONの401を返す
  if (pathname.startsWith("/api/") && !isPageLikeApi) {
    return NextResponse.json(
      { error: "認証が必要です。ログインしてください。", code: "unauthorized" },
      { status: 401 }
    );
  }

  // 画面(ページ)、およびGoogle OAuthの入口・コールバックは/loginへリダイレクト
  const loginUrl = new URL("/login", req.url);
  if (pathname !== "/") {
    loginUrl.searchParams.set("redirect", pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!login|api/session|_next/static|_next/image|favicon.ico).*)"],
};
