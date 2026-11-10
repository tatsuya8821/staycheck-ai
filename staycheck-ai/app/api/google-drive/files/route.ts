import { NextRequest, NextResponse } from "next/server";
import {
  listImagesInFolder,
  DriveAuthError,
  DriveNotFoundError,
  DrivePermissionError,
} from "@/app/lib/googleDrive";
import { DriveImageFile } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 指定フォルダ(サブフォルダ含む)配下の画像ファイル一覧を返す。
 * ?folderId=xxx が指定されていればそのフォルダを、
 * 指定がなければ GOOGLE_DRIVE_FOLDER_ID(ルートフォルダ)を対象にする。
 * 実体(バイナリ)はまだ取得しない、メタデータのみ。
 */
export async function GET(req: NextRequest) {
  const requestedFolderId = req.nextUrl.searchParams.get("folderId");
  const folderId = requestedFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    return NextResponse.json(
      { error: "GOOGLE_DRIVE_FOLDER_ID が設定されていません。.env.localを確認してください。" },
      { status: 400 }
    );
  }

  try {
    const files = await listImagesInFolder(folderId);
    const images: DriveImageFile[] = files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      fileUrl: `/api/google-drive/file/${f.id}?mimeType=${encodeURIComponent(f.mimeType)}`,
      thumbnailUrl: `/api/google-drive/thumbnail/${f.id}?mimeType=${encodeURIComponent(f.mimeType)}`,
    }));
    return NextResponse.json({ images });
  } catch (err) {
    console.error("Google Drive files list error:", err);

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
