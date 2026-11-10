import { getRedisClient } from "./redis";

/**
 * 共有パスワード認証の共通処理。
 *
 * - Web Crypto API(globalThis.crypto.subtle)のみを使うことで、
 *   Next.jsのmiddleware(Edgeランタイム)と、通常のAPIルート(Node.js
 *   ランタイム)の両方から同じ実装を呼べるようにしている(Node.js製の
 *   `crypto`モジュールはEdgeランタイムで使えないため)。
 * - パスワード自体(APP_PASSWORD)や署名鍵(AUTH_SECRET)はサーバー環境変数
 *   としてのみ扱い、ブラウザへは一切送らない。ブラウザに渡すのは
 *   「署名付きセッションCookie」だけで、これ単体からパスワードは復元できない。
 */

export const SESSION_COOKIE_NAME = "mpqc_session";
/** セッションCookieの有効期間(秒)。7日間。 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** ログイン失敗の回数制限(Upstash Redisが設定されている場合のみ有効) */
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60; // 15分

function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(sig);
}

/** 文字列同士を、内容が漏れないよう時間差の出にくい方法で比較する */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** ログイン成功時に発行する、署名付きセッションCookieの値を作る */
export async function createSessionCookieValue(secret: string): Promise<string> {
  const payload = "authenticated";
  const signature = await hmacSign(payload, secret);
  return `${payload}.${signature}`;
}

/** セッションCookieの値が、正しい署名鍵で発行されたものかどうかを検証する */
export async function verifySessionCookieValue(
  value: string | undefined | null,
  secret: string
): Promise<boolean> {
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  const expected = await hmacSign(payload, secret);
  return timingSafeEqual(expected, signature);
}

/** 入力されたパスワードが、環境変数のAPP_PASSWORDと一致するかを確認する */
export function verifyPassword(input: string, appPassword: string): boolean {
  return timingSafeEqual(input, appPassword);
}

/**
 * ログイン失敗回数の制限(Upstash Redisが設定されている場合のみ動作する、
 * 簡易的なもの)。IPアドレス単位で、一定時間内の失敗回数を数える。
 */
export async function isLoginRateLimited(clientKey: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false; // Redis未設定の場合は制限しない(可能であれば、の対応のため)
  const count = await redis.get<number>(`login-fail:${clientKey}`);
  return typeof count === "number" && count >= LOGIN_FAIL_LIMIT;
}

/** ログイン失敗を1回記録する */
export async function recordLoginFailure(clientKey: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const key = `login-fail:${clientKey}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, LOGIN_FAIL_WINDOW_SECONDS);
  }
}

/** ログイン成功時に、失敗回数の記録をリセットする */
export async function resetLoginFailures(clientKey: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.del(`login-fail:${clientKey}`);
}

/** リクエストからクライアント識別用のキー(IPアドレスなど)を取り出す */
export function getClientKey(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return "unknown";
}
