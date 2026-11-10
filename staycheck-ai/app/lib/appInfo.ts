/**
 * アプリの名称・バージョン・説明文を一元管理する(v0.4.2〜)。
 *
 * - バージョンは package.json の "version" と必ず一致させる
 *   (app/lib/__tests__/appInfo.test.ts で自動確認している)。
 * - ここには画面に表示してよい情報だけを置く。APIキー・環境変数・認証情報・
 *   データベース名・内部URLなどの機密情報は置かない(クライアント側にも読み込まれるため)。
 * - 判定処理の動作には一切関与しない(表示専用)。
 */

export const APP_NAME = "StayCheck AI";
export const APP_VERSION = "0.4.3.1";
/** 日本語の説明(用途が分かる短い説明) */
export const APP_DESCRIPTION_JA = "宿泊施設向け 清掃写真チェック支援";
/** 副題 */
export const APP_SUBTITLE = "AIが清掃写真を一次チェックし、確認作業を支援します。";

/** 判定に使っているAIモデル(表示用。実際の指定は app/api/judge/route.ts。一致はテストで確認) */
export const AI_MODEL_LABEL = "gpt-5.5";
/** 判定履歴の保存期間(日)。実際の値は app/lib/history/runId.ts。一致はテストで確認 */
export const HISTORY_RETENTION_DAYS = 180;

/** 「アプリ情報」画面に表示する項目(すべて固定の文章。機密情報は含めない) */
export const APP_INFO_ITEMS: { label: string; value: string }[] = [
  { label: "アプリ名", value: `${APP_NAME}(${APP_DESCRIPTION_JA})` },
  { label: "バージョン", value: `v${APP_VERSION}` },
  {
    label: "AIの役割",
    value: "AIは清掃写真の一次チェックを支援します。最終的な判断は、利用者(管理者・スタッフ)が行ってください。",
  },
  { label: "写真の扱い", value: "写真そのものは履歴に保存しません。保存するのは判定結果(判定・要約・チェック項目など)だけです。" },
  { label: "判定履歴の保存期間", value: `${HISTORY_RETENTION_DAYS}日(期間を過ぎた履歴は自動で削除されます)` },
  { label: "使用しているAI", value: `OpenAI API(${AI_MODEL_LABEL})` },
  {
    label: "料金",
    value: "OpenAI APIは従量課金です。判定した枚数に応じて費用が発生します(概算はチェック画面に表示されます)。",
  },
  { label: "Google Drive連携", value: "対応しています。Google Driveの写真を取り込んで判定できます(利用するには、管理者による連携設定が必要です)。" },
  { label: "開発状況", value: "開発・検証中の試作品です。" },
];
