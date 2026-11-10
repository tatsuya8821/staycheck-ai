import { NextRequest, NextResponse } from "next/server";
import {
  listProperties,
  createProperty,
  RegistryValidationError,
  RegistryNotFoundError,
} from "@/app/lib/companyRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 指定した会社の物件一覧を返す */
export async function GET(req: NextRequest, { params }: { params: { companyId: string } }) {
  try {
    return NextResponse.json({ properties: await listProperties(params.companyId) });
  } catch (err) {
    console.error("properties list error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}

/** 物件を新規登録する */
export async function POST(req: NextRequest, { params }: { params: { companyId: string } }) {
  try {
    const body = await req.json();
    const propertyId = typeof body?.propertyId === "string" ? body.propertyId.trim() : "";
    const propertyLabel = typeof body?.propertyLabel === "string" ? body.propertyLabel.trim() : "";
    const ruleText = typeof body?.ruleText === "string" ? body.ruleText : "";
    if (!propertyId || !propertyLabel) {
      return NextResponse.json({ error: "物件ID・物件名の両方を入力してください。" }, { status: 400 });
    }
    const property = await createProperty(params.companyId, propertyId, propertyLabel, ruleText);
    return NextResponse.json({ property }, { status: 201 });
  } catch (err) {
    console.error("property create error:", err);
    if (err instanceof RegistryValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RegistryNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラーが発生しました。" },
      { status: 500 }
    );
  }
}
