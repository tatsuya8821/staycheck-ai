import type { HistoryHeader } from "./types";

/** 日時を日本時間で表示する */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 履歴の対象(標準モード / 会社 / 会社・物件)の表示名 */
export function formatTarget(h: Pick<HistoryHeader, "mode" | "companyId" | "companyLabel" | "propertyId" | "propertyLabel">): string {
  if (h.mode === "standard") return "標準モード";
  const company = h.companyLabel ?? h.companyId ?? "";
  if (h.mode === "company") return company;
  return `${company}・${h.propertyLabel ?? h.propertyId ?? ""}`;
}
