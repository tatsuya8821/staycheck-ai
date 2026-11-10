import { Judgment, PhotoStatus } from "@/app/types";

export const JUDGMENT_STYLE: Record<
  Judgment,
  { ring: string; text: string; bg: string; label: string }
> = {
  "◎ 良好": {
    ring: "border-teal",
    text: "text-teal",
    bg: "bg-teal-soft",
    label: "良好",
  },
  "○ 基準内": {
    ring: "border-sky",
    text: "text-sky",
    bg: "bg-sky-soft",
    label: "基準内",
  },
  "◇ 確認推奨": {
    ring: "border-mustard",
    text: "text-mustard",
    bg: "bg-mustard-soft",
    label: "確認推奨",
  },
  "△ 要調整": {
    ring: "border-terracotta",
    text: "text-terracotta",
    bg: "bg-terracotta-soft",
    label: "要調整",
  },
};

/** サムネイル右上などに載せる小さめの判定バッジ(水平表示) */
export function StampBadge({
  judgment,
  size = "md",
}: {
  judgment: Judgment;
  size?: "sm" | "md";
}) {
  const style = JUDGMENT_STYLE[judgment];
  const padding = size === "sm" ? "px-2 py-0.5" : "px-3 py-1";
  const markText = size === "sm" ? "text-xs" : "text-sm";
  const labelText = size === "sm" ? "text-[9px]" : "text-xs";

  return (
    <div
      className={`fade-up pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full border ${padding} ${style.ring} ${style.bg} shadow-card`}
      aria-hidden="true"
    >
      <span className={`font-display ${markText} font-bold leading-none ${style.text}`}>
        {judgment.split(" ")[0]}
      </span>
      {size === "md" && (
        <span className={`font-display ${labelText} font-bold tracking-wide ${style.text}`}>
          {style.label}
        </span>
      )}
    </div>
  );
}

/** 判定前・判定中・エラー時のステータス表示 */
export function StatusPill({ status }: { status: PhotoStatus }) {
  const map: Record<PhotoStatus, { text: string; className: string }> = {
    waiting: { text: "未判定", className: "bg-mist text-inkfaint border-hairline" },
    judging: { text: "判定中…", className: "bg-teal-soft text-teal border-teal/30" },
    done: { text: "完了", className: "bg-teal-soft text-teal border-teal/30" },
    error: { text: "エラー", className: "bg-terracotta-soft text-terracotta border-terracotta/30" },
  };
  const s = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${s.className}`}
    >
      {s.text}
    </span>
  );
}
