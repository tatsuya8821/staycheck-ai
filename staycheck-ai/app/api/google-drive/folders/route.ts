import { NextResponse } from "next/server";
import {
  listSubfolders,
  DriveAuthError,
  DriveNotFoundError,
  DrivePermissionError,
} from "@/app/lib/googleDrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GOOGLE_DRIVE_FOLDER_ID(ルートフォルダ)直下のサブフォルダ一覧を返す。
 * 「物件A」「物件B」のように物件ごとにフォルダが分かれている場合、
 * フロントエンドはこれで物件フォルダの選択肢を表示する。
 */
export async function GET() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    return NextResponse.json(
      { error: "GOOGLE_DRIVE_FOLDER_ID が設定されていません。.env.localを確認してください。" },
      { status: 400 }
    );
  }

  try {
    const folders = await listSubfolders(folderId);
    return NextResponse.json({ folders, rootFolderId: folderId });
  } catch (err) {
    console.error("Google Drive folders list error:", err);

    if (err instanceof DriveAuthError) {
      return NextResponse.json({ error: err.message, code: "auth" }, { status: 401 });
    }
    if (err instanceof DriveNotFoundError) {
      return NextResponse.json({ error: err.message, code: "not_found" }, { status: 404 });
    }
    if (err instanceof DrivePermissionError) {
      return NextResponse.json({ error: err.message, code: "permission" }, { status: 403 });
    }

    const message = err instanceof Error ? err.message : "不明なエラーが発生しました。";
    return NextResponse.json(
      { error: `Google Driveとの通信に失敗しました: ${message}`, code: "unknown" },
      { status: 502 }
    );
  }
}
