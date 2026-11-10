import { RuleDefinition } from "./types";

/** 解決済みのルール配列を、AIへ渡す1本のプロンプト文字列に変換する */
export function buildPromptText(rules: RuleDefinition[]): string {
  return rules.map((r) => r.instruction).join("\n\n");
}
