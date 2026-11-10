"use client";

import { PhotoItem, PHOTO_CATEGORY_LABELS, PhotoCategory, getPhotoDisplayName } from "@/app/types";
import { StampBadge, StatusPill } from "./JudgmentBadges";

interface Props {
  photo: PhotoItem;
  onClick: () => void;
  onRemove: () => void;
  onCategoryChange: (category: PhotoCategory) => void;
}

export function PhotoCard({ photo, onClick, onRemove, onCategoryChange }: Props) {
  const displayName = getPhotoDisplayName(photo);
  return (
    <div className="group relative">
      <button
        onClick={onClick}
        className="relative block h-32 w-full overflow-hidden rounded-xl border border-hairline bg-mist"
      >
        <img
          src={photo.previewUrl}
          alt={displayName}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
        {photo.status === "judging" && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/40">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          </div>
        )}
        {photo.status === "done" && photo.result && (
          <StampBadge judgment={photo.result.judgment} size="sm" />
        )}
      </button>

      {/*
        削除ボタン: タップ領域は44px前後を確保。
        PC(hover可能な環境)では従来通り、通常時は薄く・ホバーで濃く表示する
        (globals.cssの.hover-revealで制御)。スマホ・タブレットでは
        常時はっきり表示され、サムネイル左上の角だけに重なる程度の
        大きさ・位置に留めている。
      */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="hover-reveal absolute -left-2.5 -top-2.5 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-surface text-base text-inkfaint shadow-card transition-opacity hover:text-terracotta"
        aria-label="削除"
      >
        ×
      </button>

      <select
        value={photo.category}
        onChange={(e) => onCategoryChange(e.target.value as PhotoCategory)}
        onClick={(e) => e.stopPropagation()}
        disabled={photo.status === "judging"}
        className="mt-1.5 w-full rounded-md border border-hairline bg-surface px-1.5 py-1.5 text-xs text-ink outline-none disabled:opacity-50"
      >
        {Object.entries(PHOTO_CATEGORY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <div className="mt-1.5 flex items-center justify-between gap-1">
        <span className="truncate font-mono text-[10px] text-inkfaint">
          {displayName}
        </span>
        <StatusPill status={photo.status} />
      </div>
    </div>
  );
}
