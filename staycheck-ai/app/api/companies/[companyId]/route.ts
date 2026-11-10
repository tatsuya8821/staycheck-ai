import { NextResponse } from "next/server";
import { deleteCompany } from "@/app/lib/companyRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 会社を削除する(所属する物件もすべてカスケード削除される) */
export async function DELETE(req: Request, { params }: { params: { companyId: string } }) {
  try {
    await deleteCompany(params.companyId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("company delete error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}
