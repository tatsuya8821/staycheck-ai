"use client";

import { Suspense, useState } from "react";
import { APP_DESCRIPTION_JA, APP_NAME } from "@/app/lib/appInfo";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "ログインに失敗しました。");
        return;
      }
      const redirectTo = searchParams.get("redirect") || "/";
      router.replace(redirectTo);
      router.refresh();
    } catch {
      setErrorMsg("通信中にエラーが発生しました。");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-mist px-6">
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-8 shadow-card">
        <p className="text-xs text-inkfaint">{APP_DESCRIPTION_JA}</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">{APP_NAME}</h1>
        <p className="mt-1 text-sm text-inkfaint">
          共有パスワードを入力してください
        </p>

        <form onSubmit={handleSubmit} className="mt-6">
          <label className="block text-xs font-medium text-inkfaint">
            パスワード
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="mt-1 w-full rounded-lg border border-hairline bg-mist px-3 py-2.5 text-sm text-ink outline-none focus:border-teal"
          />

          {errorMsg && (
            <p className="mt-3 text-sm text-terracotta">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting || password.length === 0}
            className="mt-5 w-full rounded-lg bg-ink px-4 py-3 font-display text-sm font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30 enabled:hover:opacity-90"
          >
            {isSubmitting ? "確認中…" : "ログイン"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
