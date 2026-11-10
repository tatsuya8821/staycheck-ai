import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import type { Credentials } from "google-auth-library";
import { getRedisClient } from "./redis";

/**
 * Google Drive OAuthトークンの保存先。
 *
 * - Upstash Redisが設定されている場合(UPSTASH_REDIS_REST_URL /
 *   UPSTASH_REDIS_REST_TOKEN)は、常にRedisを使う(本番環境はこちらが必須)。
 * - Redisが設定されておらず、かつ開発環境(NODE_ENV !== "production")の
 *   場合のみ、ローカルの `.data` フォルダへのファイル保存にフォールバックする
 *   (これまでの試作品開発時と同じ挙動)。
 * - Redisが設定されておらず、かつ本番環境(NODE_ENV === "production")の
 *   場合は、ファイルへ静かにフォールバックせず、はっきりしたエラーを投げる
 *   (本番でファイル保存に頼ると、サーバーレス環境等でトークンが消える
 *   問題が再発するため)。
 */

const REDIS_KEY = "minpaku-cleaning-checker:google-drive-tokens";
const TOKEN_DIR = path.join(process.cwd(), ".data");
const TOKEN_PATH = path.join(TOKEN_DIR, "google-drive-tokens.json");

/** 本番環境でトークンの保存先(Upstash Redis)が設定されていない場合のエラー */
export class MissingTokenStorageError extends Error {}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function requireStorageOrThrow(): never {
  throw new MissingTokenStorageError(
    "本番環境ではUPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN の設定が必須です。" +
      "Google Drive連携のトークンを安全に保存できないため処理を中止しました。" +
      "環境変数を設定してください。"
  );
}

export async function loadTokens(): Promise<Credentials | null> {
  const redis = getRedisClient();
  if (redis) {
    const data = await redis.get<Credentials>(REDIS_KEY);
    return data ?? null;
  }

  if (isProduction()) requireStorageOrThrow();

  // ここから先はローカル開発環境のみのフォールバック
  try {
    const raw = await readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: Credentials): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(REDIS_KEY, tokens);
    return;
  }

  if (isProduction()) requireStorageOrThrow();

  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export async function clearTokens(): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(REDIS_KEY);
    return;
  }

  if (isProduction()) requireStorageOrThrow();

  try {
    await unlink(TOKEN_PATH);
  } catch {
    // 元々ファイルが無い場合は何もしない
  }
}
