import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mergeItems, aggregateItems } from "../history/merge";
import { calcCostUsd, sumUsage } from "../pricing";
import type { HistoryItem } from "../history/types";

/** 写真ごとの判定世代番号による更新順序の管理と、集計の検証 */

function item(photoKey: string, gen: number, judgment: HistoryItem["judgment"] = "◎ 良好"): HistoryItem {
  return {
    photoKey,
    gen,
    fileName: "dummy.jpg",
    source: "local",
    category: "auto",
    propertyName: "",
    status: "done",
    judgment,
    summary: `世代${gen}`,
    checks: [],
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedTokens: 200 },
    judgedAt: new Date(1_790_000_000_000 + gen).toISOString(),
  };
}
function err(photoKey: string, gen: number): HistoryItem {
  return { photoKey, gen, fileName: "dummy.jpg", source: "local", category: "auto", propertyName: "", status: "error", errorCode: "rate_limited", judgedAt: new Date(1_790_000_000_000 + gen).toISOString() };
}

describe("mergeItems", () => {
  test("新しい世代は置き換え、古い世代は無視、同じ内容は変更なし", () => {
    const a = randomUUID();
    const b = randomUUID();
    const base = mergeItems([], [item(a, 2), err(b, 1)]).items;

    const newer = mergeItems(base, [item(b, 2)]);
    assert.equal(newer.changed, true);
    assert.equal(newer.replaced, 1);
    assert.equal(newer.items[1].status, "done");
    assert.deepEqual(newer.items[0], base[0], "対象外の写真は同じオブジェクト内容のまま");

    const stale = mergeItems(base, [item(a, 1)]);
    assert.equal(stale.changed, false);
    assert.equal(stale.staleIgnored, 1);
    assert.equal(stale.items[0].gen, 2);

    const same = mergeItems(base, [item(a, 2), err(b, 1)]);
    assert.equal(same.changed, false);
    assert.equal(same.unchanged, 2);
  });

  test("同じ世代で内容が違う場合は既存を優先する", () => {
    const a = randomUUID();
    const base = mergeItems([], [item(a, 1, "◎ 良好")]).items;
    const r = mergeItems(base, [item(a, 1, "△ 要調整")]);
    assert.equal(r.changed, false);
    assert.equal(r.conflicts, 1);
    assert.equal(r.items[0].judgment, "◎ 良好");
  });

  test("新しい写真は末尾に追加され、既存の写真は削除されない", () => {
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const base = mergeItems([], keys.slice(0, 2).map((k) => item(k, 1))).items;
    const r = mergeItems(base, [item(keys[2], 1)]);
    assert.deepEqual(r.items.map((i) => i.photoKey), keys);
    assert.equal(mergeItems(r.items, []).items.length, 3);
  });

  test("費用は保存時点の単価で写真ごとに計算される(比較対象には含めない)", () => {
    const a = randomUUID();
    const r = mergeItems([], [item(a, 1)]);
    assert.equal(r.items[0].costUsd, calcCostUsd(item(a, 1).usage!));
    const again = mergeItems(r.items, [item(a, 1)]);
    assert.equal(again.changed, false);
  });
});

describe("aggregateItems", () => {
  test("4段階の件数・エラー数・費用(既存の計算式と一致)", () => {
    const items = [
      item(randomUUID(), 1, "◎ 良好"),
      item(randomUUID(), 1, "○ 基準内"),
      item(randomUUID(), 1, "◇ 確認推奨"),
      item(randomUUID(), 1, "△ 要調整"),
      item(randomUUID(), 1, "△ 要調整"),
      err(randomUUID(), 1),
    ];
    const agg = aggregateItems(items);
    assert.deepEqual(agg.counts, { "◎ 良好": 1, "○ 基準内": 1, "◇ 確認推奨": 1, "△ 要調整": 2 });
    assert.equal(agg.errorCount, 1);
    assert.equal(agg.photoCount, 6);
    const usages = items.filter((i) => i.usage).map((i) => i.usage!);
    assert.equal(agg.costUsd, calcCostUsd(sumUsage(usages)));
  });
});
