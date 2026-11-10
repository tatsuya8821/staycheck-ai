export function ComingSoonPage({ title }: { title: string }) {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-10">
      <p className="font-mono text-xs tracking-widest text-inkfaint">STAYCHECK AI</p>
      <h1 className="mt-2 font-display text-2xl font-bold text-ink">{title}</h1>
      <div className="mt-8 rounded-2xl border border-hairline bg-surface p-10 text-center shadow-card">
        <p className="font-display text-sm font-bold text-inkfaint">準備中です</p>
        <p className="mt-2 text-sm text-inkfaint">
          この機能は今後、段階的に実装していく予定です。
        </p>
      </div>
    </main>
  );
}
