import { RuleRegistry } from "./types";

/**
 * 会社別ルール・物件別カルテのレジストリ。
 * staycheck-ai-v0.1.0 時点では、登録済みの会社・物件は存在しない
 * (標準基準のみで動作する)。
 *
 * 新しい導入会社を正式に受け入れる段階で、この配列に
 * CompanyRuleSet / PropertyRuleSet を追加していく想定。
 * 実在する会社名・物件名を、テストや動作確認のためにここへ
 * 仮置きしないこと(架空のテストデータはテストコード内でのみ生成する)。
 */
export const registry: RuleRegistry = {
  companies: [],
  properties: [],
};
