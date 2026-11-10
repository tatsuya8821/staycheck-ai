"use client";

import { useEffect, useState } from "react";
import { PhotoItem, PHOTO_CATEGORY_LABELS, getPhotoDisplayName } from "@/app/types";
import { JUDGMENT_STYLE } from "./JudgmentBadges";

interface Props {
  photo: PhotoItem;
  onClose: () => void;
}

export function Lightbox({ photo, onClose }: Props) {
  const displayName = getPhotoDisplayName(photo);

  // Drive写真は判定後に実データ(file)を解放しているため、拡大表示時に
  // フル解像度の画像を改めて取得する。ローカル写真はpreviewUrlがそのまま
  // フル解像度なので、この処理は不要。
  const needsFullImageFetch = photo.source === "drive" && !photo.file;
  const [fullImageUrl, setFullImageUrl] = useState<string | null>(
    needsFullImageFetch ? null : photo.previewUrl
  );
  const [fullImageError, setFullImageError] = useState<string | null>(null);

  useEffect(() => {
    if (!needsFullImageFetch || !photo.driveFileId) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    const mimeType = photo.driveMimeType ?? "image/jpeg";
    fetch(
      `/api/google-drive/file/${photo.driveFileId}?mimeType=${encodeURIComponent(mimeType)}`
    )
      .then(async (res) => {
        if (!res.ok) throw new Error("画像の取得に失敗しました。");
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setFullImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFullImageError("拡大画像の読み込みに失敗しました。");
      });

    // 閉じた・写真が切り替わった時に、取得したフル画像のメモリを解放する
    return () => {
      cancelled = true;
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // 二重解放などは無視してよい
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id, needsFullImageFetch, photo.driveFileId, photo.driveMimeType]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // v0.4.3: 判定理由(チェック項目)が多い・長い場合に、画面内で最後までスクロールして読めるようにした。
    // スマホ幅では写真の高さを抑えて、判定理由の欄を広く取る。通常の内容でのPC表示は従来どおり。
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="fade-up relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface shadow-card md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex max-h-[45vh] min-h-0 flex-1 items-center justify-center bg-ink/5 p-2 md:max-h-[80vh]">
          {fullImageUrl ? (
            <img
              src={fullImageUrl}
              alt={displayName}
              className="max-h-[42vh] max-w-full rounded-lg object-contain md:max-h-[76vh]"
            />
          ) : fullImageError ? (
            <p className="text-sm text-terracotta">{fullImageError}</p>
          ) : (
            <div className="flex flex-col items-center gap-2 p-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-hairline border-t-teal" />
              <p className="text-sm text-inkfaint">拡大画像を読み込み中…</p>
            </div>
          )}
        </div>

        <div className="min-h-0 w-full overflow-y-auto border-t border-hairline p-5 [overflow-wrap:anywhere] md:w-72 md:shrink-0 md:border-l md:border-t-0" data-testid="lightbox-details">
          <p className="font-mono text-xs text-inkfaint">{displayName}</p>
          <p className="mt-1 font-display text-sm font-bold text-ink">
            {photo.propertyName || "(物件名未入力)"}
          </p>
          <p className="mt-0.5 text-xs text-inkfaint">
            カテゴリ: {PHOTO_CATEGORY_LABELS[photo.category]}
          </p>

          {photo.status === "judging" && (
            <p className="mt-4 text-sm text-inkfaint">判定中です…</p>
          )}

          {photo.status === "error" && (
            <p className="mt-4 text-sm text-terracotta">{photo.errorMsg}</p>
          )}

          {photo.status === "done" && photo.result && (
            <div className="mt-4">
              <div
                className={`rounded-xl border p-3 ${JUDGMENT_STYLE[photo.result.judgment].ring} ${JUDGMENT_STYLE[photo.result.judgment].bg}`}
              >
                <p className={`font-display text-lg font-bold ${JUDGMENT_STYLE[photo.result.judgment].text}`}>
                  {photo.result.judgment}
                </p>
                <p className="mt-1 text-sm text-ink">{photo.result.summary}</p>
              </div>
              <ul className="mt-3 space-y-1.5">
                {photo.result.checks.map((c, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-lg border border-hairline px-2.5 py-1.5 text-xs"
                  >
                    <span className="text-ink">{c.label}</span>
                    <span
                      className={`ml-2 shrink-0 whitespace-nowrap font-mono font-medium ${c.ok ? "text-teal" : "text-terracotta"}`}
                    >
                      {c.ok ? "OK" : "要確認"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 text-lg text-ink shadow-card"
          aria-label="閉じる"
        >
          ×
        </button>
      </div>
    </div>
  );
}
