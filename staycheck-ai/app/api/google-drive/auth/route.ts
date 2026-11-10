import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthUrl, getAppOrigin } from "@/app/lib/googleDrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 「Google Driveに接続」ボタンから呼ばれる。
 * Googleの同意画面へブラウザごとリダイレクトする。
 */
export async function GET(req: NextRequest) {
  try {
    const url = getGoogleAuthUrl();
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("Google Drive auth error:", err);
    const message = err instanceof Error ? err.message : "Google認証の開始に失敗しました。";
    // リダイレクト先の組み立てには req.url ではなく、GOOGLE_REDIRECT_URI から
    // 導出した信頼できる公開オリジンを使う(本番でlocalhostへ飛ぶ問題を防ぐため)。
    return NextResponse.redirect(
      new URL(`/?driveError=${encodeURIComponent(message)}`, getAppOrigin())
    );
  }
}
