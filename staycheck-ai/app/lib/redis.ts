import { Redis } from "@upstash/redis";

/**
 * Upstash Redisクライアントを取得する。
 * 環境変数(UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)が
 * 設定されていない場合は null を返す(呼び出し側でフォールバック処理を行う)。
 *
 * このモジュールは Edge / Node.js のどちらのランタイムからも呼べる
 * (Upstash RedisはREST API経由でfetchを使うだけなので、Next.jsの
 * middleware(Edgeランタイム)からも利用できる)。
 */
export function getRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
