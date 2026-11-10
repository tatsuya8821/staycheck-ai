import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { guardRequest } from "../apiGuard";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../auth";

/** 履歴APIの防御(ログイン確認・送信元・データ形式・サイズ) */

const SECRET = "guard-test-secret";
let cookie: string;

function req(method: string, headers: Record<string, string> = {}, body?: string) {
  return new Request("http://app.example.test/api/history/x", { method, headers: { host: "app.example.test", ...headers }, body });
}

describe("guardRequest", () => {
  before(async () => {
    process.env.AUTH_SECRET = SECRET;
    cookie = `${SESSION_COOKIE_NAME}=${await createSessionCookieValue(SECRET)}`;
  });

  test("Cookieなし・署名不正は401", async () => {
    const r1 = await guardRequest(req("GET"));
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.response.status, 401);
    const forged = `${SESSION_COOKIE_NAME}=${await createSessionCookieValue("other-secret")}`;
    const r2 = await guardRequest(req("GET", { cookie: forged }));
    if (!r2.ok) assert.equal(r2.response.status, 401);
    else assert.fail("署名不正が通ってしまった");
  });

  test("正しいCookieのGETは通る", async () => {
    const r = await guardRequest(req("GET", { cookie }));
    assert.equal(r.ok, true);
  });

  test("書き込み系: Originが無い・別サイトなら403、自サイトなら通る", async () => {
    const none = await guardRequest(req("DELETE", { cookie }), { mutating: true });
    assert.equal(!none.ok && none.response.status, 403);
    const evil = await guardRequest(req("DELETE", { cookie, origin: "https://evil.example" }), { mutating: true });
    assert.equal(!evil.ok && evil.response.status, 403);
    const ok = await guardRequest(req("DELETE", { cookie, origin: "http://app.example.test" }), { mutating: true });
    assert.equal(ok.ok, true);
    const proxied = await guardRequest(
      req("DELETE", { cookie, origin: "https://public.example.test", "x-forwarded-host": "public.example.test" }),
      { mutating: true }
    );
    assert.equal(proxied.ok, true, "プロキシ経由(x-forwarded-host)でも自サイト判定できる");
  });

  test("JSON以外は415、サイズ超過は413、壊れたJSONは400", async () => {
    const base = { cookie, origin: "http://app.example.test" };
    const form = await guardRequest(req("PUT", { ...base, "content-type": "application/x-www-form-urlencoded" }, "a=1"), { mutating: true, readJsonBody: true });
    assert.equal(!form.ok && form.response.status, 415);
    const big = await guardRequest(req("PUT", { ...base, "content-type": "application/json" }, JSON.stringify({ x: "a".repeat(5000) })), {
      mutating: true,
      readJsonBody: true,
      maxBodyBytes: 1000,
    });
    assert.equal(!big.ok && big.response.status, 413);
    const broken = await guardRequest(req("PUT", { ...base, "content-type": "application/json" }, "{"), { mutating: true, readJsonBody: true });
    assert.equal(!broken.ok && broken.response.status, 400);
    const good = await guardRequest(req("PUT", { ...base, "content-type": "application/json" }, '{"a":1}'), { mutating: true, readJsonBody: true });
    assert.ok(good.ok && (good.body as { a: number }).a === 1);
  });

  test("エラー応答はキャッシュさせない", async () => {
    const r = await guardRequest(req("GET"));
    assert.ok(!r.ok && r.response.headers.get("cache-control") === "no-store");
  });
});
