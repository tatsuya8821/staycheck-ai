import { JudgeResult, PhotoCategory } from "@/app/types";

/** 429(レート制限)時の最大リトライ回数 */
const MAX_RETRIES = 4;

/** 指数バックオフの基準時間・上限(ミリ秒) */
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 20000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 429時の待機時間を計算する。
 * OpenAI公式が推奨する「指数バックオフ + ジッター」方式:
 * 待機時間 = min(上限, 基準時間 × 2^試行回数) + 0〜1秒のランダムな揺らぎ
 * サーバーが Retry-After ヘッダーを返している場合は、そちらを優先する。
 * (参考: https://platform.openai.com/docs/guides/rate-limits)
 */
function computeBackoffDelayMs(attempt: number, res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  const jitter = Math.random() * 1000;
  return exponential + jitter;
}

/** レート制限のリトライを使い果たして最終的に失敗したことを示すエラー */
export class RateLimitExhaustedError extends Error {}

export interface JudgePhotoCallbacks {
  /** 429を受け取るたびに呼ばれる(リトライで成功した場合も含め、発生した回数分呼ばれる) */
  onRateLimited?: () => void;
  /** 実際に待機してリトライを行うたびに呼ばれる */
  onRetry?: (attempt: number, delayMs: number) => void;
}

/**
 * 写真1枚をサーバーのAI判定APIに送信する。
 * 呼び出し側（page.tsxなど）はこの関数を呼ぶことで判定を行う。
 * OpenAI APIのレート制限(429)が発生した場合は、指数バックオフ+ジッターで
 * 待機時間を計算し、自動的に最大4回まで再試行する。
 * それでも失敗すれば RateLimitExhaustedError を投げる(呼び出し元でログ集計用に判別可能)。
 */
export async function judgePhoto(
  file: File,
  propertyName: string,
  category: PhotoCategory = "auto",
  callbacks?: JudgePhotoCallbacks,
  ruleTarget?: { companyId?: string; propertyId?: string }
): Promise<JudgeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const formData = new FormData();
    formData.append("photo", file);
    formData.append("propertyName", propertyName);
    formData.append("category", category);
    // ruleTarget: 物件管理で登録した会社・物件を判定に適用する場合のみ指定する。
    // 省略・空の場合は送信せず、サーバーは標準基準のみで判定する(従来と同じ)。
    if (ruleTarget?.companyId) {
      formData.append("companyId", ruleTarget.companyId);
      if (ruleTarget.propertyId) {
        formData.append("propertyId", ruleTarget.propertyId);
      }
    }

    const res = await fetch("/api/judge", {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      return (await res.json()) as JudgeResult;
    }

    const data = await res.json().catch(() => null);

    // レート制限(429)は、リトライ回数が残っていれば指数バックオフで再試行する
    if (res.status === 429) {
      callbacks?.onRateLimited?.();
      if (attempt < MAX_RETRIES) {
        const delayMs = computeBackoffDelayMs(attempt, res);
        callbacks?.onRetry?.(attempt + 1, delayMs);
        await wait(delayMs);
        continue;
      }
      throw new RateLimitExhaustedError(
        data?.error ?? "レート制限により判定できませんでした。"
      );
    }

    throw new Error(data?.error ?? "判定に失敗しました。");
  }

  // ここには到達しないが、型を満たすために念のため
  throw new Error("判定に失敗しました。");
}
