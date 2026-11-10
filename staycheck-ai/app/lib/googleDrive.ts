import { google } from "googleapis";
import { OAuth2Client, Credentials } from "google-auth-library";
import { ALLOWED_IMAGE_TYPES } from "@/app/types";
import {
  loadTokens,
  saveTokens,
  clearTokens as clearStoredTokens,
} from "./tokenStore";

/**
 * Google Drive連携(OAuth 2.0)の共通処理。
 *
 * 設計方針:
 * - 既存のAI判定処理(app/api/judge/route.ts)には一切依存しない、独立したモジュール。
 * - トークンの実際の保存・読込・削除は app/lib/tokenStore.ts に委譲している。
 *   本番環境ではUpstash Redis、ローカル開発環境ではファイル保存にフォールバックする
 *   (詳細はtokenStore.tsのコメントを参照)。トークンはブラウザへは絶対に渡さない。
 */

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

/** 環境変数が揃っているかを確認し、揃っていなければ分かりやすいエラーを投げる */
function getOAuthEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google連携の環境変数(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)が設定されていません。.env.localを確認してください。"
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** 保存済みトークンを削除する(接続解除・エラー時のリセット用) */
export async function clearDriveTokens(): Promise<void> {
  await clearStoredTokens();
}

/** GOOGLE_REDIRECT_URIの形式・環境に応じた妥当性が不正な場合のエラー */
export class InvalidRedirectUriError extends Error {}

/**
 * アプリの公開オリジン(スキーム+ホスト)を、GOOGLE_REDIRECT_URIから導出する。
 *
 * リクエストの`req.url`(Railway等のリバースプロキシ環境下では、内部的な
 * localhost等を指してしまうことがある)には依存せず、Google Cloud Console
 * に登録済みの、確実に正しいリダイレクトURIから逆算することで、本番で
 * localhostへ誤ってリダイレクトされる問題を防ぐ。
 *
 * - 文字列置換ではなく `new URL(GOOGLE_REDIRECT_URI).origin` で取得する
 *   (URLの構造を正しく解析するため、末尾スラッシュの有無などに影響されない)。
 * - 本番環境(NODE_ENV=production)では、httpsであることを必須とし、
 *   localhost/127.0.0.1は拒否する(誤設定にすぐ気づけるようにするため)。
 * - GOOGLE_REDIRECT_URIが未設定・不正な形式の場合は、localhostへ静かに
 *   フォールバックせず、明確なエラーを投げる。
 * - ローカル開発環境では http://localhost をそのまま許可する。
 */
export function getAppOrigin(): string {
  const { redirectUri } = getOAuthEnv();

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new InvalidRedirectUriError(
      `GOOGLE_REDIRECT_URI の形式が正しくありません(値: "${redirectUri}")。https://から始まる完全なURLを設定してください。`
    );
  }

  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";

  if (process.env.NODE_ENV === "production") {
    if (parsed.protocol !== "https:") {
      throw new InvalidRedirectUriError(
        "本番環境のGOOGLE_REDIRECT_URIはhttps://である必要があります。現在の値はhttpsではありません。"
      );
    }
    if (isLocalhost) {
      throw new InvalidRedirectUriError(
        "本番環境のGOOGLE_REDIRECT_URIにlocalhostが設定されています。公開用のドメインを設定してください。"
      );
    }
  }

  return parsed.origin;
}

/** OAuth同意画面へのURLを生成する */
export function getGoogleAuthUrl(): string {
  const { clientId, clientSecret, redirectUri } = getOAuthEnv();
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  return client.generateAuthUrl({
    access_type: "offline", // refresh_tokenを受け取るために必須
    prompt: "consent", // 毎回同意画面を出し、確実にrefresh_tokenを発行させる
    scope: SCOPES,
  });
}

/** 認可コードをトークンに交換し、サーバー側に保存する */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const { clientId, clientSecret, redirectUri } = getOAuthEnv();
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
}

/** 現在Google Driveに接続済みかどうか(トークンが保存されているか)を返す */
export async function isDriveConnected(): Promise<boolean> {
  const tokens = await loadTokens();
  return Boolean(tokens?.refresh_token || tokens?.access_token);
}

/**
 * 認証済みのOAuth2クライアントを取得する。
 * アクセストークンの期限が切れていても、refresh_tokenがあれば
 * googleapisライブラリが自動的に更新してくれる。更新後は
 * saveTokensで保存し直す(次回以降も使えるようにするため)。
 */
async function getAuthorizedClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret, redirectUri } = getOAuthEnv();
  const tokens = await loadTokens();

  if (!tokens) {
    throw new DriveAuthError("Google Driveに接続されていません。先に「Google Driveに接続」を行ってください。");
  }

  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  client.setCredentials(tokens);

  // トークンが自動更新された場合(トークンリフレッシュ時)に保存し直す
  client.on("tokens", (newTokens) => {
    void saveTokens({ ...tokens, ...newTokens });
  });

  return client;
}

/** Drive連携特有のエラー(未接続・権限不足などをUI側で判別するための専用クラス) */
export class DriveAuthError extends Error {}
export class DriveNotFoundError extends Error {}
export class DrivePermissionError extends Error {}

interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveFolderMeta {
  id: string;
  name: string;
}

/**
 * 指定フォルダの直下(1階層のみ)にあるサブフォルダの一覧を取得する。
 * 「物件A」「物件B」のように物件ごとにフォルダを分けている場合、
 * まずこれで物件フォルダを選ばせてから、そのフォルダだけを対象に
 * listImagesInFolder を呼ぶ、という使い方を想定している。
 */
export async function listSubfolders(folderId: string): Promise<DriveFolderMeta[]> {
  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth });

  const folders: DriveFolderMeta[] = [];
  let pageToken: string | undefined;

  do {
    let res;
    try {
      res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: "nextPageToken, files(id, name)",
        pageSize: 1000,
        pageToken,
        orderBy: "name",
      });
    } catch (err: any) {
      const status = err?.code || err?.response?.status;
      if (status === 404) {
        throw new DriveNotFoundError(
          "指定されたGoogle Driveフォルダが見つかりません。GOOGLE_DRIVE_FOLDER_IDが正しいか確認してください。"
        );
      }
      if (status === 403) {
        throw new DrivePermissionError(
          "Google Driveフォルダへのアクセス権限がありません。フォルダの共有設定を確認してください。"
        );
      }
      throw err;
    }

    for (const f of res.data.files ?? []) {
      if (f.id && f.name) folders.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return folders;
}

/**
 * 指定フォルダ配下(サブフォルダを含む)の画像ファイル一覧を取得する。
 * 既存のALLOWED_IMAGE_TYPES(jpeg/png/webp)に含まれる画像のみを対象とする
 * (HEIC等、既存のAI判定APIが対応していない形式は一覧にも含めない)。
 */
export async function listImagesInFolder(folderId: string): Promise<DriveFileMeta[]> {
  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth });

  const images: DriveFileMeta[] = [];
  const folderQueue: string[] = [folderId];
  let checkedRootFolder = false;

  while (folderQueue.length > 0) {
    const currentFolderId = folderQueue.shift()!;
    let pageToken: string | undefined;

    do {
      let res;
      try {
        res = await drive.files.list({
          q: `'${currentFolderId}' in parents and trashed = false`,
          fields: "nextPageToken, files(id, name, mimeType)",
          pageSize: 1000,
          pageToken,
        });
      } catch (err: any) {
        const status = err?.code || err?.response?.status;
        if (status === 404) {
          throw new DriveNotFoundError(
            "指定されたGoogle Driveフォルダが見つかりません。GOOGLE_DRIVE_FOLDER_IDが正しいか確認してください。"
          );
        }
        if (status === 403) {
          throw new DrivePermissionError(
            "Google Driveフォルダへのアクセス権限がありません。フォルダの共有設定を確認してください。"
          );
        }
        throw err;
      }

      checkedRootFolder = true;
      const files = res.data.files ?? [];

      for (const f of files) {
        if (!f.id || !f.name || !f.mimeType) continue;

        if (f.mimeType === "application/vnd.google-apps.folder") {
          // サブフォルダも対象にする(12: サブフォルダ対応)
          folderQueue.push(f.id);
          continue;
        }

        if (ALLOWED_IMAGE_TYPES.includes(f.mimeType)) {
          images.push({ id: f.id, name: f.name, mimeType: f.mimeType });
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  if (!checkedRootFolder) {
    throw new DriveNotFoundError(
      "指定されたGoogle Driveフォルダが見つかりません。GOOGLE_DRIVE_FOLDER_IDが正しいか確認してください。"
    );
  }

  return images;
}

/** 1枚の画像ファイルの中身(バイナリ)をDriveから取得する */
export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth });

  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data as ArrayBuffer);
  } catch (err: any) {
    const status = err?.code || err?.response?.status;
    if (status === 404) {
      throw new DriveNotFoundError("指定された画像がGoogle Drive上に見つかりません。");
    }
    if (status === 403) {
      throw new DrivePermissionError("この画像にアクセスする権限がありません。");
    }
    throw err;
  }
}

/**
 * 1枚の画像のサムネイル(Googleが生成する小さいプレビュー画像)をDriveから取得する。
 * 一覧表示(グリッド)で大量の写真を並べる際、フル解像度の本体を毎回
 * ダウンロードするとメモリ・通信量を大きく消費するため、代わりにこちらを使う。
 * サムネイルが提供されていないファイルの場合は null を返す
 * (呼び出し側は、その場合フル解像度の本体を使うなどのフォールバックを行う)。
 */
export async function getDriveThumbnail(
  fileId: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth });

  try {
    const meta = await drive.files.get({
      fileId,
      fields: "thumbnailLink",
    });
    const thumbnailLink = meta.data.thumbnailLink;
    if (!thumbnailLink) return null;

    // thumbnailLinkは認証が必要なGoogle側のURLなので、同じ認証済みクライアントで取得する
    const res = await auth.request<ArrayBuffer>({
      url: thumbnailLink,
      responseType: "arraybuffer",
    });
    const contentType = (res.headers?.["content-type"] as string) || "image/jpeg";
    return { buffer: Buffer.from(res.data), contentType };
  } catch (err: any) {
    const status = err?.code || err?.response?.status;
    if (status === 404) {
      throw new DriveNotFoundError("指定された画像がGoogle Drive上に見つかりません。");
    }
    if (status === 403) {
      throw new DrivePermissionError("この画像にアクセスする権限がありません。");
    }
    // サムネイル取得固有の失敗は致命的エラーにせず、呼び出し側でフォールバックできるようnullを返す
    console.error("Drive thumbnail fetch error:", err);
    return null;
  }
}
