import { NextRequest, NextResponse } from "next/server";
import {
  getProperty,
  updateProperty,
  deleteProperty,
  RegistryNotFoundError,
} from "@/app/lib/companyRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: { companyId: string; propertyId: string };
}

/** 物件1件の詳細を取得する */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const property = await getProperty(params.companyId, params.propertyId);
    if (!property) {
      return NextResponse.json({ error: "指定された物件が見つかりません。" }, { status: 404 });
    }
    return NextResponse.json({ property });
  } catch (err) {
    console.error("property get error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}

/** 物件を更新する(表示名・自由記述ルール) */
export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json();
    const propertyLabel = typeof body?.propertyLabel === "string" ? body.propertyLabel.trim() : undefined;
    const ruleText = typeof body?.ruleText === "string" ? body.ruleText : undefined;
    const property = await updateProperty(params.companyId, params.propertyId, { propertyLabel, ruleText });
    return NextResponse.json({ property });
  } catch (err) {
    console.error("property update error:", err);
    if (err instanceof RegistryNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}

/** 物件を削除する */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    await deleteProperty(params.companyId, params.propertyId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("property delete error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}
