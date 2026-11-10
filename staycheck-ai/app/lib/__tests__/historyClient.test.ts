import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HistorySaver, type SaverStatus } from "../history/client";
import type { HistoryItem, HistoryTarget } from "../history/types";

/**
 * 画面側の履歴保存キュー(HistorySaver)のテスト。
 * 実際の通信は行わず、fetchを差し替えた疑似サーバーで動作を確認する。
 */

const STANDARD: HistoryTarget = { mode: "standard" };

function item(photoKey: string, gen: number): HistoryItem {
  return { photoKey, gen, fileName: "d.jpg", source: "local", category: "auto", propertyName: "", status: "done", judgment: "◎ 良好", summary: "", checks: [], judgedAt: new Date(0).toISOString() };
}

type Call = { method: string; url: string; body: any };

function fakeServer(script: (call: Call, n: number) => { status: number; body: any } | undefined = () => undefined) {
  const calls: Call[] = [];
  let runSeq = 0;
  const revs = new Map<string, number>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = { method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const override = script(call, calls.length);
    if (override) return new Response(JSON.stringify(override.body), { status: override.status });
    if (call.method === "POST") return new Response(JSON.stringify({ runId: `run-${++runSeq}` }), { status: 201 });
    const runId = url.split("/").pop()!;
    const rev = (revs.get(runId) ?? 0) + 1;
    revs.set(runId, rev);
    return new Response(JSON.stringify({ status: "saved", rev, photoCount: call.body.items.length }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function makeSaver(fetchImpl: typeof fetch) {
  const statuses: SaverStatus[] = [];
  const sleeps: number[] = [];
  const saver = new HistorySaver({
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onStatus: (s) => statuses.push(s),
  });
  return { saver, statuses, sleeps };
}

describe("HistorySaver", () => {
  test("履歴IDの発行 → 保存の順に1回ずつ送る", async () => {
    const srv = fakeServer();
    const { saver, statuses } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1), item(randomUUID(), 1)]);
    assert.deepEqual(srv.calls.map((c) => c.method), ["POST", "PUT"]);
    assert.equal(srv.calls[1].body.baseRev, 0);
    assert.equal(statuses.at(-1)!.state, "saved");
  });

  test("一時的な失敗は2秒後・8秒後に自動再試行し、履歴IDは再発行しない", async () => {
    const srv = fakeServer((c, n) => (c.method === "PUT" && n <= 3 ? { status: 503, body: { code: "busy" } } : undefined));
    const { saver, sleeps, statuses } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.deepEqual(sleeps, [2000, 8000]);
    assert.equal(srv.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(statuses.at(-1)!.state, "saved");
    const urls = new Set(srv.calls.filter((c) => c.method === "PUT").map((c) => c.url));
    assert.equal(urls.size, 1, "再送はすべて同じ履歴IDへ");
  });

  test("自動再試行を使い切ったら「再送」待ちになり、再送で同じ履歴へ保存される", async () => {
    let failing = true;
    const srv = fakeServer((c) => (c.method === "PUT" && failing ? { status: 500, body: {} } : undefined));
    const { saver, statuses } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    const last = statuses.at(-1)!;
    assert.equal(last.state, "failed");
    assert.equal((last as { retryable: boolean }).retryable, true);
    failing = false;
    await saver.retry();
    await saver.retry(); // 連打しても重複しない
    assert.equal(statuses.at(-1)!.state, "saved");
    assert.equal(srv.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(saver.runIds.length, 1);
    assert.equal(srv.calls.filter((c) => c.method === "PUT").length, 4, "失敗3回+成功1回。2回目の再送は送るものがないので送信しない");
  });

  test("送信中に同じ写真の新しい世代が来たら、次の送信で新しい世代だけを送る", async () => {
    const k = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = fakeServer();
    let first = true;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init.method === "PUT" && first) {
        first = false;
        await gate;
      }
      return base.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const { saver } = makeSaver(fetchImpl);
    const p1 = saver.enqueue(STANDARD, [item(k, 1)]);
    await new Promise((r) => setTimeout(r, 10));
    const p2 = saver.enqueue(STANDARD, [item(k, 2)]);
    release();
    await Promise.all([p1, p2]);
    await saver.retry();
    const puts = base.calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 2);
    assert.equal(puts[0].body.items[0].gen, 1);
    assert.equal(puts[1].body.items[0].gen, 2);
    assert.equal(puts[1].body.baseRev, 1, "直前の保存で確認した更新番号を送る");
  });

  test("古い世代を後から渡しても、保存待ちの新しい世代を上書きしない", async () => {
    const k = randomUUID();
    const srv = fakeServer((c) => (c.method === "PUT" ? { status: 500, body: {} } : undefined));
    const { saver } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(k, 3)]);
    await saver.enqueue(STANDARD, [item(k, 2)]);
    const puts = srv.calls.filter((c) => c.method === "PUT");
    assert.equal(puts.at(-1)!.body.items[0].gen, 3);
  });

  test("「すべて削除」・対象の変更・300枚超で新しい履歴になる", async () => {
    const srv = fakeServer();
    const { saver } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(saver.runIds.length, 1, "同じ作業中は同じ履歴");
    saver.newSession();
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(saver.runIds.length, 2);
    await saver.enqueue({ mode: "company", companyId: "test-co" }, [item(randomUUID(), 1)]);
    assert.equal(saver.runIds.length, 3);
    await saver.enqueue({ mode: "company", companyId: "test-co" }, Array.from({ length: 299 }, () => item(randomUUID(), 1)));
    assert.equal(saver.runIds.length, 3, "合計300枚までは同じ履歴");
    await saver.enqueue({ mode: "company", companyId: "test-co" }, [item(randomUUID(), 1)]);
    assert.equal(saver.runIds.length, 4, "301枚目で新しい履歴");
  });

  test("履歴機能が無効(503 history_disabled)なら以後は送信しない", async () => {
    const srv = fakeServer(() => ({ status: 503, body: { code: "history_disabled" } }));
    const { saver, statuses, sleeps } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(statuses.at(-1)!.state, "disabled");
    assert.equal(sleeps.length, 0);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(srv.calls.length, 1);
  });

  test("削除済み(410)の履歴には再送せず、次の判定は新しい履歴に保存する", async () => {
    let gone = true;
    const srv = fakeServer((c) => (c.method === "PUT" && gone ? { status: 410, body: { code: "gone" } } : undefined));
    const { saver, statuses, sleeps } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(statuses.at(-1)!.state, "failed");
    assert.equal(sleeps.length, 0, "再試行しない");
    gone = false;
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(saver.runIds.length, 2);
    assert.equal(statuses.at(-1)!.state, "saved");
  });

  test("ログイン切れ(401)は自動再試行せず「再送」待ちにする(無限ループしない)", async () => {
    const srv = fakeServer(() => ({ status: 401, body: { code: "unauthorized" } }));
    const { saver, statuses, sleeps } = makeSaver(srv.fetchImpl);
    await saver.enqueue(STANDARD, [item(randomUUID(), 1)]);
    assert.equal(srv.calls.length, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(statuses.at(-1)!.state, "failed");
  });
});
