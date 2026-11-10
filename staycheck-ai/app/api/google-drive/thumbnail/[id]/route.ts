import { NextRequest, NextResponse } from "next/server";
import {
  getDriveThumbnail,
  downloadDriveFile,
  DriveAuthError,
  DriveNotFoundError,
  DrivePermissionError,
} from "@/app/lib/googleDrive";
import { ALLOWED_IMAGE_TYPES } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 一覧のサムネイル表示専用のエンドポイント。
 * フル解像度の本体(/api/google-drive/file/[id])とは異なり、
 * Googleが生成する小さいプレビュー画像だけを取得するため、
 * 大量の写真を一覧表示してもメモリ・通信量を抑えられる。
 * サムネイルが提供されていないファイルの場合のみ、フル解像度側にフォールバックする。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const fileId = params.id;
  const mimeTypeParam = req.nextUrl.searchParams.get("mimeType") ?? "";
  const fallbackMimeType = ALLOWED_IMAGE_TYPES.includes(mimeTypeParam)
    ? mimeTypeParam
    : "image/jpeg";

  try {
    const thumbnail = await getDriveThumbnail(fileId);

    if (thumbnail) {
      return new NextResponse(new Uint8Array(thumbnail.buffer), {
        status: 200,
        headers: {
          "Content-Type": thumbnail.contentType,
          "Cache-Control": "private, max-age=600",
        },
      });
    }

    // サムネイルが提供されていない場合のみ、フル解像度本体で代用する
    const buffer = await downloadDriveFile(fileId);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": fallbackMimeType,
        "Cache-Control": "private, max-age=600",
      },
    });
  } catch (err) {
    console.error("Google Drive thumbnail error:", err);

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
      { error: `サムネイルの取得に失敗しました: ${message}`, code: "unknown" },
      { status: 502 }
    );
  }
}
