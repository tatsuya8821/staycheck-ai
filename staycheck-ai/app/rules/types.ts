/**
 * ルール階層(標準基準・会社別ルール・物件別カルテ)の共通型定義。
 *
 * 設計方針:
 * - 標準・会社・物件のいずれの層も、同じ RuleDefinition の配列として表現する。
 * - 統合は「同じidがあれば丸ごと上書き、無いidは追加」という決定的な処理
 *   (resolveRules.ts)で行い、プロンプト文中の自然文だけで優先順位を
 *   AIに委ねることはしない。
 * - 現段階(staycheck-ai-v0.1.0)では registry.companies / registry.properties
 *   は空配列。会社を正式に受け入れる段階で、この型に沿ったデータを追加する。
 */

export type RuleSource = "standard" | "company" | "property";

/** ルール1件分。標準・会社・物件のいずれの層でも同じ形を使う */
export interface RuleDefinition {
  /** 安定した識別子。同じidは「同じ観点についてのルール」を意味し、上書きの単位になる */
  id: string;
  /** グルーピング用のカテゴリ名(例: "cleanliness" "perception" "output") */
  category: string;
  /** AIへ渡す実際の指示文(この文言をそのままプロンプトに連結する) */
  instruction: string;
  /** falseの場合、このルールは最終プロンプトに含めない(上位層からの無効化に使う) */
  enabled: boolean;
  /** どの層で定義されたルールか(結合後もデバッグ・監査用に保持する) */
  source: RuleSource;
  /** 同一category内での並び順(小さいほど先に出力。省略時は定義順) */
  order?: number;
}

export interface CompanyRuleSet {
  companyId: string;
  /** 画面表示用の名称。AIへ送るプロンプトには含めない */
  companyLabel: string;
  /** v0.2.0時点では常に空配列(会社レベルの独自ルールは今回未対応) */
  rules: RuleDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface PropertyRuleSet {
  companyId: string;
  propertyId: string;
  /** 画面表示用の名称。AIへ送るプロンプトには含めない */
  propertyLabel: string;
  /**
   * スキーマのバージョン。将来、自由記述から構造化ルール(structuredRules)へ
   * 拡張する際に、既存データを無理に移行せず共存させるために使う。
   */
  schemaVersion: 1;
  /** 物件固有ルール(自由記述のテキスト)。v0.2.0時点ではこちらのみ使用する */
  ruleText: string;
  /** 将来用の予約フィールド。v0.2.0では常にundefined(未使用) */
  structuredRules?: RuleDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface RuleRegistry {
  companies: CompanyRuleSet[];
  properties: PropertyRuleSet[];
}

/** ルール解決に失敗した場合のエラー種別 */
export type RuleResolutionErrorCode =
  | "unknown_company"
  | "unknown_property"
  | "property_without_company";

export class RuleResolutionError extends Error {
  code: RuleResolutionErrorCode;
  constructor(code: RuleResolutionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
