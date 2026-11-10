import { NextRequest, NextResponse } from "next/server";
import {
  downloadDriveFile,
  DriveAuthError,
  DriveNotFoundError,
  DrivePermissionError,
} from "@/app/lib/googleDrive";
import { ALLOWED_IMAGE_TYPES } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 1枚の画像ファイルの中身をGoogle Driveから取得し、そのまま返す。
 * フロントエンドは <img src="/api/google-drive/file/xxx?mimeType=..."> の形で
 * サムネイル表示に使うほか、「選択した写真を追加」時に fetch して
 * Fileオブジェクトへ変換するのにも使う。
 * Googleのトークンはこのサーバー側処理の中だけで使われ、ブラウザには渡らない。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const fileId = params.id;
  const mimeTypeParam = req.nextUrl.searchParams.get("mimeType") ?? "";

  // 既存のAI判定が対応している形式のみ許可する(HEIC等は対象外)
  const mimeType = ALLOWED_IMAGE_TYPES.includes(mimeTypeParam)
    ? mimeTypeParam
    : "image/jpeg";

  try {
    const buffer = await downloadDriveFile(fileId);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    console.error("Google Drive file download error:", err);

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
      { error: `画像の取得に失敗しました: ${message}`, code: "unknown" },
      { status: 502 }
    );
  }
}
