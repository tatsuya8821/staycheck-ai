"use client";

import { PhotoItem, getPhotoDisplayName } from "@/app/types";
import { JUDGMENT_STYLE } from "./JudgmentBadges";

interface Props {
  photo: PhotoItem;
  onClick: () => void;
}

export function ResultRow({ photo, onClick }: Props) {
  if (!photo.result) return null;
  const style = JUDGMENT_STYLE[photo.result.judgment];
  const displayName = getPhotoDisplayName(photo);

  // スマホ幅(640px未満, v0.4.3〜): 判定と物件名、要約(最大2行)、ファイル名を縦に並べ、
  // 長いファイル名・要約でも行が画面からはみ出さないようにする。PC幅の並びは従来どおり。
  return (
    <button
      onClick={onClick}
      data-testid="result-row"
      className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-mist sm:items-center sm:gap-4 ${style.ring} bg-surface`}
    >
      <img
        src={photo.previewUrl}
        alt={displayName}
        loading="lazy"
        decoding="async"
        className="h-14 w-14 shrink-0 rounded-lg object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:flex-nowrap">
          <span
            data-testid="result-judgment"
            className={`whitespace-nowrap font-display text-sm font-bold ${style.text}`}
          >
            {photo.result.judgment}
          </span>
          <span className="min-w-0 max-w-full truncate text-xs text-inkfaint">
            {photo.propertyName || "(物件名未入力)"}
          </span>
        </div>
        {/* スマホ幅: 要約は2行まで表示し、区切りのない長い文字列も折り返す */}
        <p className="mt-0.5 line-clamp-2 text-sm text-ink [overflow-wrap:anywhere] sm:hidden">
          {photo.result.summary}
        </p>
        <p className="mt-0.5 hidden truncate text-sm text-ink sm:block">{photo.result.summary}</p>
        {/* スマホ幅: ファイル名は要約の下に1行で(長い場合は省略) */}
        <p className="mt-0.5 truncate font-mono text-[10px] text-inkfaint sm:hidden">{displayName}</p>
      </div>
      <span className="hidden max-w-[40%] shrink-0 truncate font-mono text-[10px] text-inkfaint sm:block">
        {displayName}
      </span>
    </button>
  );
}
