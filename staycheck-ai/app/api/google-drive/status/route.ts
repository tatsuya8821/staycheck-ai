import { NextResponse } from "next/server";
import { isDriveConnected } from "@/app/lib/googleDrive";
import { MissingTokenStorageError } from "@/app/lib/tokenStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 現在Google Driveに接続済みかどうかを返す(UI初期表示の判定用) */
export async function GET() {
  try {
    const connected = await isDriveConnected();
    return NextResponse.json({ connected });
  } catch (err) {
    console.error("Google Drive status check error:", err);
    if (err instanceof MissingTokenStorageError) {
      return NextResponse.json({ error: err.message, code: "storage_not_configured" }, { status: 500 });
    }
    const message = err instanceof Error ? err.message : "不明なエラーが発生しました。";
    return NextResponse.json({ error: message, code: "unknown" }, { status: 500 });
  }
}
