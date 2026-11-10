import { calcCostUsd, sumUsage } from "@/app/lib/pricing";
import type { Judgment, TokenUsage } from "@/app/types";
import type { HistoryItem } from "./types";

/**
 * 既存の写真結果と、新しく送られてきた写真結果をまとめる(純粋関数)。
 *
 * 写真ごとの判定世代番号(gen)で更新順序を管理する:
 * - gen が既存より大きい → 新しい再判定結果なので置き換える
 * - gen が既存と同じで内容も同じ → 同じ内容の再送。何も変えない(更新番号も増やさない)
 * - gen が既存と同じで内容が違う → 本来起きない。既存を優先して残す(conflicts に数える)
 * - gen が既存より小さい → 古い保存リクエスト。無視する(staleIgnored に数える)
 * 既存にない写真は末尾に追加する。既存の写真を削除することはない。
 */

/** 内容比較用の正規化(費用は単価から再計算される派生値なので比較に含めない) */
export function canonicalItem(item: HistoryItem): string {
  return JSON.stringify([
    item.photoKey,
    item.gen,
    item.fileName,
    item.source,
    item.category,
    item.propertyName,
    item.status,
    item.judgment ?? null,
    item.summary ?? null,
    (item.checks ?? []).map((c) => [c.label, c.ok]),
    item.usage
      ? [item.usage.inputTokens, item.usage.outputTokens, item.usage.totalTokens, item.usage.cachedTokens ?? 0]
      : null,
    item.errorCode ?? null,
    item.judgedAt,
  ]);
}

function withCost(item: HistoryItem): HistoryItem {
  if (item.status === "done" && item.usage) return { ...item, costUsd: calcCostUsd(item.usage) };
  const { costUsd: _drop, ...rest } = item;
  return rest;
}

export interface MergeResult {
  items: HistoryItem[];
  changed: boolean;
  replaced: number;
  added: number;
  unchanged: number;
  staleIgnored: number;
  conflicts: number;
}

export function mergeItems(existing: HistoryItem[], incoming: HistoryItem[]): MergeResult {
  const items = existing.slice();
  const indexByKey = new Map(items.map((it, i) => [it.photoKey, i]));
  const result: MergeResult = { items, changed: false, replaced: 0, added: 0, unchanged: 0, staleIgnored: 0, conflicts: 0 };

  for (const next of incoming) {
    const idx = indexByKey.get(next.photoKey);
    if (idx === undefined) {
      indexByKey.set(next.photoKey, items.length);
      items.push(withCost(next));
      result.added += 1;
      result.changed = true;
      continue;
    }
    const current = items[idx];
    if (next.gen > current.gen) {
      items[idx] = withCost(next);
      result.replaced += 1;
      result.changed = true;
    } else if (next.gen < current.gen) {
      result.staleIgnored += 1;
    } else if (canonicalItem(next) === canonicalItem(current)) {
      result.unchanged += 1;
    } else {
      result.conflicts += 1;
    }
  }
  return result;
}

export interface HistoryAggregates {
  photoCount: number;
  counts: Record<Judgment, number>;
  errorCount: number;
  usage: TokenUsage;
  costUsd: number;
}

/** 写真結果の全件から概要の集計値を計算する(集計の正は常に写真結果) */
export function aggregateItems(items: HistoryItem[]): HistoryAggregates {
  const counts: Record<Judgment, number> = { "◎ 良好": 0, "○ 基準内": 0, "◇ 確認推奨": 0, "△ 要調整": 0 };
  let errorCount = 0;
  const usages: TokenUsage[] = [];
  for (const it of items) {
    if (it.status === "done" && it.judgment) {
      counts[it.judgment] += 1;
      if (it.usage) usages.push(it.usage);
    } else {
      errorCount += 1;
    }
  }
  const usage = sumUsage(usages);
  return { photoCount: items.length, counts, errorCount, usage, costUsd: usages.length ? calcCostUsd(usage) : 0 };
}
