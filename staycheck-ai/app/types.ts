/**
 * アプリ全体で共有する型定義。
 * 判定ロジックやUIを拡張する際は、まずここに型を追加する。
 */

/**
 * 判定ランク(v2.0〜4段階)
 * - ◎ 良好    : 問題なし
 * - ○ 基準内  : 軽微な事項はあるが問題なし(会社備品・経年劣化等、AIが確信を持って許容と判断)
 * - ◇ 確認推奨: AIが断定できない(反射・影・木目・模様・経年劣化・物件固有設備・確信不足等)。
 *               現場スタッフのセルフチェックを促すためのランクであり、「異常」ではない。
 * - △ 要調整  : AIが明らかな異常と判断できる場合のみ(毛髪・ゴミ・残置物・破損・明らかな汚れ等)
 */
export type Judgment = "◎ 良好" | "○ 基準内" | "◇ 確認推奨" | "△ 要調整";

export interface CheckItem {
  label: string;
  ok: boolean;
}

/**
 * OpenAI APIから返されるトークン使用量。
 * コスト計算(app/lib/pricing.ts)で使用する。
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface JudgeResult {
  judgment: Judgment;
  summary: string;
  checks: CheckItem[];
  usage?: TokenUsage;
}

/**
 * 写真カテゴリ(v2.3〜)
 * 「AIに写真の主題を推測させる」のではなく、人が明示的にカテゴリを
 * 指定することで、判定対象を確実に絞り込めるようにする。
 * カテゴリを増やす場合は、ここと app/api/judge/route.ts の
 * CATEGORY_DEFINITIONS の両方に追記する。
 */
export type PhotoCategory =
  | "auto"
  | "entrance"
  | "bed"
  | "bathroom"
  | "kitchen"
  | "washer"
  | "blinds"
  | "living"
  | "other";

export const PHOTO_CATEGORY_LABELS: Record<PhotoCategory, string> = {
  auto: "自動判定(AIが推測)",
  entrance: "玄関(傘・スリッパ)",
  bed: "ベッド・寝具",
  bathroom: "浴室・トイレ",
  kitchen: "キッチン",
  washer: "洗濯機",
  blinds: "ブラインド・窓",
  living: "リビング(ソファ等)",
  other: "その他・全体",
};

/** 写真1枚ごとの処理状態 */
export type PhotoStatus = "waiting" | "judging" | "done" | "error";

/**
 * 写真1枚分の情報。
 *
 * v2.18〜: Google Drive経由の写真はメモリ節約のため、追加した時点では
 * `file`(実データ)を持たない「軽量な状態」で保持し、判定の直前に
 * サーバー経由でDriveから取得→判定→取得後は`file`を破棄、という
 * 流れにしている(詳細は app/page.tsx の runBatchJudge を参照)。
 * そのため `file` は必須ではなく任意(undefinedになり得る)。
 * ローカルアップロードの写真は、これまで通り追加した瞬間から
 * `file`が常に存在する(破棄しない)。
 */
export interface PhotoItem {
  id: string;
  /** 写真の出どころ。ローカル選択かGoogle Driveかで、メモリの持ち方が異なる */
  source: "local" | "drive";
  /**
   * 実データ。ローカル写真は常に存在する。Drive写真は「判定中」の間だけ
   * 一時的に存在し、判定が終わると再びundefinedに戻る(メモリ解放のため)。
   */
  file?: File;
  /**
   * サムネイル表示用URL。ローカル写真は `URL.createObjectURL(file)` で
   * 作った実データ由来のURL。Drive写真は、実データをダウンロードしない
   * 軽量なサムネイル専用API(`/api/google-drive/thumbnail/...`)のURL。
   */
  previewUrl: string;
  propertyName: string;
  category: PhotoCategory;
  status: PhotoStatus;
  result?: JudgeResult;
  errorMsg?: string;
  /**
   * Google Driveから読み込んだ写真の場合、元のDriveファイルIDを保持する。
   * ローカルアップロードの写真には存在しない(undefined)。
   * 同じDriveファイルの重複追加を防ぐ・判定直前に本体を取得するために使う。
   */
  driveFileId?: string;
  /** Drive写真のファイル名(fileが破棄されている間も表示名として使う) */
  driveFileName?: string;
  /** Drive写真のMIMEタイプ(本体取得時にContent-Typeとして使う) */
  driveMimeType?: string;
}

/** 写真の表示名を取得する(fileが破棄されていてもDrive由来の情報から補う) */
export function getPhotoDisplayName(photo: PhotoItem): string {
  return photo.file?.name ?? photo.driveFileName ?? "(不明なファイル)";
}

/**
 * Google Drive上の画像ファイル1件分の情報(一覧表示用)。
 * 実体(バイナリ)はまだ取得していない、メタデータのみの状態。
 */
export interface DriveImageFile {
  id: string;
  name: string;
  mimeType: string;
  /** 判定・拡大表示時に使う、フル解像度の本体取得API URL */
  fileUrl: string;
  /** 一覧のサムネイル表示に使う、軽量なサムネイル取得API URL */
  thumbnailUrl: string;
}

/**
 * 判定結果を並べ替える際の優先度。
 * 数字が小さいほど上位（社長・取締役が先に見るべきもの）に表示する。
 * 判定ランクを増やす場合はここに追記するだけでよい。
 */
export const JUDGMENT_PRIORITY: Record<Judgment, number> = {
  "△ 要調整": 0,
  "◇ 確認推奨": 1,
  "○ 基準内": 2,
  "◎ 良好": 3,
};

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
