import { RateLimitExhaustedError } from "@/app/lib/judgePhoto";
import { getPhotoDisplayName, type JudgeResult, type PhotoItem } from "@/app/types";
import {
  HISTORY_MAX_ITEMS,
  type HistoryBatchStats,
  type HistoryErrorCode,
  type HistoryItem,
  type HistoryTarget,
} from "./types";

/**
 * チェック画面側の履歴保存(判定処理とは独立)。
 *
 * - 判定が終わった後に enqueue() を呼ぶだけで、判定処理はこの結果を待たない。
 *   保存に失敗しても判定結果の表示には一切影響しない。
 * - 同じ履歴への保存は1つずつ順番に送る。送れていない分は写真ごとに
 *   「世代番号が最も大きいもの」へまとめる。
 * - 保存はPUT(同じ内容を何度送っても結果は同じ)なので、再送しても重複しない。
 * - 自動で2回まで再試行し(2秒後・8秒後)、それでも失敗したら「再送」待ちにする。
 */

/** 判定エラーを保存用の分類に変換する(エラーの生の文面は保存しない) */
export function classifyJudgeError(err: unknown, stage: "drive" | "judge"): HistoryErrorCode {
  if (stage === "drive") return "drive_fetch_failed";
  if (err instanceof RateLimitExhaustedError) return "rate_limited";
  const message = err instanceof Error ? err.message : "";
  if (message.includes("クレジット残高")) return "quota_exceeded";
  if (message.includes("登録されていません") || message.includes("物件IDを指定する場合は会社IDも必要")) return "rule_error";
  return "judge_failed";
}

export function targetFromSelection(companyId: string, propertyId: string): HistoryTarget {
  if (companyId && propertyId) return { mode: "property", companyId, propertyId };
  if (companyId) return { mode: "company", companyId };
  return { mode: "standard" };
}

/** チェック画面の写真1枚+判定結果から、保存用の写真結果を作る */
export function buildHistoryItem(
  photo: PhotoItem,
  gen: number,
  effectivePropertyName: string,
  outcome: { result: JudgeResult } | { errorCode: HistoryErrorCode },
  judgedAt: Date
): HistoryItem {
  const base = {
    photoKey: photo.id,
    gen,
    fileName: getPhotoDisplayName(photo),
    source: photo.source,
    category: photo.category,
    propertyName: effectivePropertyName,
    judgedAt: judgedAt.toISOString(),
  };
  if ("result" in outcome) {
    const r = outcome.result;
    return {
      ...base,
      status: "done",
      judgment: r.judgment,
      summary: r.summary,
      checks: r.checks,
      ...(r.usage ? { usage: r.usage } : {}),
    };
  }
  return { ...base, status: "error", errorCode: outcome.errorCode };
}

export type SaverStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; photoCount: number }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "disabled" };

interface RunState {
  target: HistoryTarget;
  epoch: number;
  runId?: string;
  rev: number;
  photoKeys: Set<string>;
  pending: Map<string, HistoryItem>;
  batchStats?: HistoryBatchStats;
  /** 再試行しても解決しない失敗(削除済み等)。以後この履歴には送らない */
  closed: boolean;
}

export interface HistorySaverDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
  onStatus?: (status: SaverStatus) => void;
}

class SaveFailure extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly disabled = false, public readonly closeRun = false) {
    super(message);
  }
}

function sameTarget(a: HistoryTarget, b: HistoryTarget): boolean {
  return a.mode === b.mode && (a.companyId ?? "") === (b.companyId ?? "") && (a.propertyId ?? "") === (b.propertyId ?? "");
}

export class HistorySaver {
  private runs: RunState[] = [];
  private epoch = 0;
  private running = false;
  private disabled = false;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly onStatus: (status: SaverStatus) => void;

  constructor(deps: HistorySaverDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryDelaysMs = deps.retryDelaysMs ?? [2000, 8000];
    this.onStatus = deps.onStatus ?? (() => {});
  }

  /** 「すべて削除」等で作業が区切られた。次の保存からは新しい履歴にする */
  newSession(): void {
    this.epoch += 1;
  }

  /** テスト・表示用: 現在の履歴ID一覧 */
  get runIds(): string[] {
    return this.runs.filter((r) => r.runId).map((r) => r.runId!);
  }

  /** 判定結果を保存待ちに加える(待たずに戻る) */
  enqueue(target: HistoryTarget, items: HistoryItem[], batchStats?: HistoryBatchStats): Promise<void> {
    if (this.disabled || items.length === 0) return Promise.resolve();
    let run = this.runs[this.runs.length - 1];
    const newKeys = items.filter((it) => !run?.photoKeys.has(it.photoKey)).length;
    if (
      !run ||
      run.closed ||
      run.epoch !== this.epoch ||
      !sameTarget(run.target, target) ||
      run.photoKeys.size + newKeys > HISTORY_MAX_ITEMS
    ) {
      run = { target, epoch: this.epoch, rev: 0, photoKeys: new Set(), pending: new Map(), closed: false };
      this.runs.push(run);
    }
    for (const it of items) {
      run.photoKeys.add(it.photoKey);
      const prev = run.pending.get(it.photoKey);
      if (!prev || it.gen >= prev.gen) run.pending.set(it.photoKey, it);
    }
    if (batchStats) run.batchStats = batchStats;
    return this.kick();
  }

  /** 失敗後の手動「再送」 */
  retry(): Promise<void> {
    return this.kick();
  }

  private async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const run = this.runs.find((r) => !r.closed && r.pending.size > 0);
        if (!run || this.disabled) break;
        this.onStatus({ state: "saving" });
        const ok = await this.flushWithRetry(run);
        if (!ok) break; // 自動再試行を使い切った。「再送」を待つ
      }
    } finally {
      this.running = false;
    }
  }

  private async flushWithRetry(run: RunState): Promise<boolean> {
    const delays = [0, ...this.retryDelaysMs];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await this.sleep(delays[i]);
      try {
        const photoCount = await this.flushOnce(run);
        this.onStatus({ state: "saved", photoCount });
        return true;
      } catch (err) {
        const f = err instanceof SaveFailure ? err : new SaveFailure("履歴を保存できませんでした(通信エラー)。", true);
        if (f.disabled) {
          this.disabled = true;
          this.onStatus({ state: "disabled" });
          return false;
        }
        if (f.closeRun) {
          run.closed = true;
          run.pending.clear();
        }
        if (!f.retryable) {
          this.onStatus({ state: "failed", message: f.message, retryable: !f.closeRun });
          // 履歴を閉じた場合は他の保存待ちを続ける。閉じていない場合(ログイン切れ等)は「再送」を待つ
          return f.closeRun;
        }
        if (i === delays.length - 1) {
          this.onStatus({ state: "failed", message: f.message, retryable: true });
          return false;
        }
      }
    }
    return false;
  }

  private async request(url: string, init: RequestInit): Promise<{ status: number; data: any }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers: { "Content-Type": "application/json" } });
    } catch {
      throw new SaveFailure("履歴を保存できませんでした(通信エラー)。", true);
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  private failureFor(status: number, data: any): SaveFailure {
    const code = data?.code as string | undefined;
    if (status === 503 && code === "history_disabled") return new SaveFailure("", false, true);
    if (status === 401) return new SaveFailure("ログインの有効期限が切れたため、履歴を保存できませんでした。", false);
    if (status === 410 || status === 404) {
      return new SaveFailure("この履歴は削除済み、または保存期間を過ぎているため保存できませんでした。", false, false, true);
    }
    if (status === 409 || status === 429 || status >= 500) return new SaveFailure("履歴を保存できませんでした。", true);
    return new SaveFailure("履歴の保存内容に問題があったため保存できませんでした。", false, false, true);
  }

  private async flushOnce(run: RunState): Promise<number> {
    if (!run.runId) {
      const { status, data } = await this.request("/api/history/runs", {
        method: "POST",
        body: JSON.stringify({ target: run.target }),
      });
      if (status !== 201 || typeof data?.runId !== "string") throw this.failureFor(status, data);
      run.runId = data.runId;
    }
    const sending = [...run.pending.values()];
    const { status, data } = await this.request(`/api/history/${encodeURIComponent(run.runId!)}`, {
      method: "PUT",
      body: JSON.stringify({ target: run.target, baseRev: run.rev, items: sending, batchStats: run.batchStats }),
    });
    if (status !== 200) throw this.failureFor(status, data);
    run.rev = Number(data.rev) || run.rev;
    // 送信中に同じ写真の新しい世代が加わった場合は、それを残して次回送る
    for (const it of sending) {
      const cur = run.pending.get(it.photoKey);
      if (cur && cur.gen <= it.gen) run.pending.delete(it.photoKey);
    }
    return Number(data.photoCount) || run.photoKeys.size;
  }
}
