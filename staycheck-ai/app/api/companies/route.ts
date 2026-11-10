import { NextRequest, NextResponse } from "next/server";
import { listCompanies, createCompany, RegistryValidationError } from "@/app/lib/companyRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 登録済みの会社一覧を返す(実体が無いIDは自動的に除外される) */
export async function GET() {
  try {
    return NextResponse.json({ companies: await listCompanies() });
  } catch (err) {
    console.error("companies list error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}

/** 会社を新規登録する */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const companyId = typeof body?.companyId === "string" ? body.companyId.trim() : "";
    const companyLabel = typeof body?.companyLabel === "string" ? body.companyLabel.trim() : "";
    if (!companyId || !companyLabel) {
      return NextResponse.json({ error: "会社ID・会社名の両方を入力してください。" }, { status: 400 });
    }
    const company = await createCompany(companyId, companyLabel);
    return NextResponse.json({ company }, { status: 201 });
  } catch (err) {
    console.error("company create error:", err);
    if (err instanceof RegistryValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}
