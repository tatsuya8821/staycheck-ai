import { TokenUsage } from "@/app/types";

/**
 * gpt-5.5 の1Mトークンあたりの単価(USD)。
 * 2026年7月時点でOpenAIの公式料金ページに基づく。
 * 料金が変わった場合はここだけ修正すればよい。
 * 参照: https://openai.com/api/pricing/
 */
export const GPT_5_5_PRICING = {
  inputPerMillion: 5.0,
  /** プロンプトキャッシュがヒットした入力トークンの単価(通常の10%) */
  cachedInputPerMillion: 0.5,
  outputPerMillion: 30.0,
};

/**
 * 1回の判定リクエストのコスト(USD)を計算する。
 * cachedTokens が分かる場合は、その分だけ安いキャッシュ単価で計算する
 * (実際のOpenAIの請求ロジックに合わせた、より正確な計算)。
 */
export function calcCostUsd(usage: TokenUsage): number {
  const cached = usage.cachedTokens ?? 0;
  const freshInputTokens = Math.max(usage.inputTokens - cached, 0);
  const inputCost =
    (freshInputTokens / 1_000_000) * GPT_5_5_PRICING.inputPerMillion +
    (cached / 1_000_000) * GPT_5_5_PRICING.cachedInputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * GPT_5_5_PRICING.outputPerMillion;
  return inputCost + outputCost;
}

/** 複数枚分のusageを合計する */
export function sumUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      cachedTokens: (acc.cachedTokens ?? 0) + (u.cachedTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }
  );
}
