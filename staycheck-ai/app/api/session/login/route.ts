import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionCookieValue,
  verifyPassword,
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginFailures,
  getClientKey,
} from "@/app/lib/auth";

export const runtime = "nodejs";

/**
 * 共有パスワードでログインする。
 * 成功したら、署名付きのHttpOnly Cookieを発行する
 * (パスワードそのものはCookieに含めない)。
 */
export async function POST(req: NextRequest) {
  const appPassword = process.env.APP_PASSWORD;
  const authSecret = process.env.AUTH_SECRET;

  if (!appPassword || !authSecret) {
    return NextResponse.json(
      {
        error:
          "サーバー側の認証設定が不足しています(APP_PASSWORD / AUTH_SECRET未設定)。管理者に確認してください。",
      },
      { status: 500 }
    );
  }

  const clientKey = getClientKey(req);
  if (await isLoginRateLimited(clientKey)) {
    return NextResponse.json(
      {
        error:
          "ログイン試行が多すぎます。しばらく時間をおいてから再度お試しください。",
      },
      { status: 429 }
    );
  }

  let password: string;
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  if (!password || !verifyPassword(password, appPassword)) {
    await recordLoginFailure(clientKey);
    return NextResponse.json({ error: "パスワードが正しくありません。" }, { status: 401 });
  }

  await resetLoginFailures(clientKey);

  const cookieValue = await createSessionCookieValue(authSecret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
