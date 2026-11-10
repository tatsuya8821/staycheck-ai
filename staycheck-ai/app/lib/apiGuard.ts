import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from "@/app/lib/auth";

/**
 * API側の防御(ミドルウェアに加えた二重チェック)。
 * 履歴APIの各処理の冒頭で呼び、問題があればそのまま返すべきレスポンスを返す。
 *
 * - セッションCookieの署名検証(ミドルウェアの対象範囲を将来誤って変えても守られる)
 * - 書き込み系(POST/PUT/DELETE)は、送信元(Origin)が自サイトであることを確認する
 * - 本文を受け取るAPIは、Content-Typeがapplication/jsonであることと、サイズ上限を確認する
 *
 * 注意: 共有パスワード方式のため、ログインした人は全員同じ権限になる。
 * 会社ごとのアクセス分離はできない(docs/KNOWN_ISSUES.md 参照)。
 */

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export function errorResponse(status: number, code: string, error: string): NextResponse {
  return jsonResponse({ error, code }, status);
}

export interface GuardOptions {
  /** 書き込み系のリクエストか(Originを確認する) */
  mutating?: boolean;
  /** JSON本文を読み取るか(Content-Typeとサイズを確認し、解析結果を返す) */
  readJsonBody?: boolean;
  /** 本文の上限バイト数(既定: 2MB) */
  maxBodyBytes?: number;
}

export type GuardResult =
  | { ok: true; body?: unknown }
  | { ok: false; response: NextResponse };

function expectedHost(req: Request): string | null {
  // Railway等のプロキシ経由では x-forwarded-host に公開ホスト名が入る
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0].trim().toLowerCase();
  const host = req.headers.get("host");
  return host ? host.toLowerCase() : null;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export async function guardRequest(req: Request, opts: GuardOptions = {}): Promise<GuardResult> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return { ok: false, response: errorResponse(503, "auth_not_configured", "認証設定が不足しています。管理者に確認してください。") };
  }
  const valid = await verifySessionCookieValue(readCookie(req, SESSION_COOKIE_NAME), secret);
  if (!valid) {
    return { ok: false, response: errorResponse(401, "unauthorized", "認証が必要です。ログインしてください。") };
  }

  if (opts.mutating) {
    const origin = req.headers.get("origin");
    const host = expectedHost(req);
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : null;
    } catch {
      originHost = null;
    }
    if (!originHost || !host || originHost !== host) {
      return { ok: false, response: errorResponse(403, "forbidden_origin", "このサイト以外からの操作は受け付けていません。") };
    }
  }

  if (opts.readJsonBody) {
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return { ok: false, response: errorResponse(415, "unsupported_media_type", "JSON形式で送信してください。") };
    }
    const max = opts.maxBodyBytes ?? 2 * 1024 * 1024;
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > max) {
      return { ok: false, response: errorResponse(413, "payload_too_large", "送信データが大きすぎます。") };
    }
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > max) {
      return { ok: false, response: errorResponse(413, "payload_too_large", "送信データが大きすぎます。") };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, response: errorResponse(400, "invalid_json", "送信データを解析できませんでした。") };
    }
  }

  return { ok: true };
}
