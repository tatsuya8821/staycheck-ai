import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, getAppOrigin } from "@/app/lib/googleDrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Googleの同意画面から戻ってきた際に呼ばれるコールバック。
 * 認可コード(code)をアクセストークン・リフレッシュトークンに交換し、
 * サーバー側にのみ保存する(ブラウザには一切トークンを渡さない)。
 * 交換が終わったら、トップページへ結果フラグ付きでリダイレクトする。
 *
 * リダイレクト先の組み立てには req.url ではなく、GOOGLE_REDIRECT_URI から
 * 導出した信頼できる公開オリジン(getAppOrigin())を使う。Railway等の
 * リバースプロキシ環境では req.url が内部的なlocalhostを指すことがあり、
 * それが「認証後にlocalhostへ飛ぶ」不具合の原因だったため。
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const errorParam = req.nextUrl.searchParams.get("error");

  if (errorParam) {
    // ユーザーがGoogleの同意画面でキャンセルした場合など
    return NextResponse.redirect(
      new URL(`/?driveError=${encodeURIComponent("Google認証がキャンセルされました。")}`, getAppOrigin())
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(`/?driveError=${encodeURIComponent("Google認証コードが取得できませんでした。")}`, getAppOrigin())
    );
  }

  try {
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(new URL("/?driveConnected=1", getAppOrigin()));
  } catch (err) {
    console.error("Google Drive callback error:", err);
    const message = err instanceof Error ? err.message : "Google認証の完了に失敗しました。";
    return NextResponse.redirect(
      new URL(`/?driveError=${encodeURIComponent(message)}`, getAppOrigin())
    );
  }
}
