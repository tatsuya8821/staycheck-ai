import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { buildCategoryInstruction } from "./categoryRules";
import { resolveRules } from "@/app/rules/resolveRules";
import { loadRegistrySnapshot } from "@/app/lib/companyRegistry";
import { buildPromptText } from "@/app/rules/buildPrompt";
import { RuleResolutionError } from "@/app/rules/types";

export const runtime = "nodejs";

const JUDGMENT_VALUES = ["◎ 良好", "○ 基準内", "◇ 確認推奨", "△ 要調整"] as const;
type Judgment = (typeof JUDGMENT_VALUES)[number];

interface CheckItem {
  label: string;
  ok: boolean;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

interface JudgeResult {
  judgment: Judgment;
  summary: string;
  checks: CheckItem[];
  usage?: TokenUsage;
}

/** OpenAI Responses API の output 配列からテキスト本文を取り出す */
function extractOutputText(data: any): string {
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const textPart = item.content.find(
        (c: any) => c.type === "output_text"
      );
      if (textPart?.text) return textPart.text;
    }
  }
  return "";
}

/**
 * OpenAI Responses API のレスポンスからトークン使用量を取り出す。
 * usage情報が含まれていない場合は undefined を返す。
 * cachedTokens はプロンプトキャッシュがどれだけ効いているかの診断用。
 */
function extractTokenUsage(data: any): TokenUsage | undefined {
  const usage = data?.usage;
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const cachedTokens =
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0;
  return { inputTokens, outputTokens, totalTokens, cachedTokens };
}

/**
 * 「正しく整頓された状態」の見本写真。
 * ここに写真を追加すると、判定リクエストのたびに参考例としてAIに提示される。
 *
 * v0.1.0時点では意図的に空にしている(元のプロトタイプにあった見本画像は
 * 実際の導入企業の物件写真だった可能性が高いため、汎用版には含めていない)。
 * 今後、権利関係が明確な汎用の見本画像を用意できた場合、この配列に
 * { path, caption } を追加すればよい(loadReferenceContentの実装は変更不要)。
 */
const REFERENCE_IMAGES: { path: string; caption: string }[] = [];

let cachedReferenceContent: any[] | null = null;

/**
 * 見本画像をbase64で読み込み、Responses APIのuser contentブロックに変換する。
 * 初回リクエスト時に読み込み、以降はメモリ上にキャッシュして使い回す。
 * REFERENCE_IMAGESが空の場合は、空配列をそのまま返す(エラーにはしない)。
 */
async function loadReferenceContent(): Promise<any[]> {
  if (cachedReferenceContent) return cachedReferenceContent;

  const blocks: any[] = [];
  for (const ref of REFERENCE_IMAGES) {
    try {
      const filePath = path.join(process.cwd(), "app/api/judge", ref.path);
      const buf = await readFile(filePath);
      const base64 = buf.toString("base64");
      blocks.push({ type: "input_text", text: ref.caption });
      blocks.push({
        type: "input_image",
        image_url: `data:image/jpeg;base64,${base64}`,
        detail: "high",
      });
    } catch (err) {
      console.error(`参照画像の読み込みに失敗しました: ${ref.path}`, err);
    }
  }
  cachedReferenceContent = blocks;
  return blocks;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "OPENAI_API_KEY が設定されていません。プロジェクト直下に .env.local を作成し、OPENAI_API_KEY=sk-... を設定してからサーバーを再起動してください。",
        },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("photo");
    const propertyNameRaw = formData.get("propertyName");
    const propertyName =
      typeof propertyNameRaw === "string" ? propertyNameRaw.trim() : "";
    const categoryRaw = formData.get("category");
    const category = typeof categoryRaw === "string" ? categoryRaw : "auto";
    // companyId/propertyId: ルール階層(標準/会社/物件)の選択に使う識別子。
    // v0.1.0時点ではフロント側から送られてこないため、常に未指定(標準モード)になる。
    // 将来、会社・物件の選択UIが追加された際に、ここで受け取る想定で先に用意している。
    const companyIdRaw = formData.get("companyId");
    const companyId = typeof companyIdRaw === "string" && companyIdRaw ? companyIdRaw : undefined;
    const propertyIdRaw = formData.get("propertyId");
    const propertyId = typeof propertyIdRaw === "string" && propertyIdRaw ? propertyIdRaw : undefined;

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "写真ファイルが見つかりません。" },
        { status: 400 }
      );
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "JPEG / PNG / WebP形式の画像のみ対応しています。" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const dataUrl = `data:${file.type};base64,${base64}`;

    // 見本画像(ソファの整頓例)は、ソファの判定に関係するカテゴリの時だけ添付する。
    // 「自動判定」を含むそれ以外のカテゴリでは、トークン削減のため添付しない。
    const needsSofaReference = category === "living";
    const referenceContent = needsSofaReference ? await loadReferenceContent() : [];

    // ルール階層(標準/会社/物件)を解決し、プロンプトを組み立てる。
    // companyId/propertyIdが未指定であれば標準基準のみが返る。
    // 未登録のIDが指定された場合は、標準モードへ黙って戻さずエラーにする。
    const categoryInstruction = buildCategoryInstruction(category);
    let systemPrompt: string;
    try {
      // companyId未指定(標準モード)ではRedisへ一切アクセスしない=既存挙動は不変
      const registrySnapshot = companyId ? await loadRegistrySnapshot() : undefined;
      const rules = resolveRules(companyId, propertyId, registrySnapshot);
      systemPrompt = [buildPromptText(rules), categoryInstruction ?? ""]
        .filter(Boolean)
        .join("\n\n");
    } catch (err) {
      if (err instanceof RuleResolutionError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
      }
      throw err;
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [
          {
            role: "system",
            content: systemPrompt,
          },
          ...(referenceContent.length > 0
            ? [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "これから判定してもらう前に、参考写真を提示します。以下は「整頓されている」と判断してよい基準の見本です。",
                    },
                    ...referenceContent,
                  ],
                },
              ]
            : []),
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `物件名: ${
                  propertyName || "(未入力)"
                }\n上記の見本・ルールを基準として、この清掃写真を検査し、指定のJSON形式で判定を返してください。`,
              },
              {
                // detail: "high" を明示することで、クッションの傾きなど
                // 細部の違いが見落とされにくくなる(未指定だと粗い解像度で
                // 解析される場合がある)
                type: "input_image",
                image_url: dataUrl,
                detail: "high",
              },
            ],
          },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      console.error("OpenAI API error:", openaiResponse.status, errText);

      if (openaiResponse.status === 429) {
        // 429には「一時的なレート制限(rate_limit_exceeded)」と
        // 「クレジット残高不足(insufficient_quota)」の2種類が混在している。
        // 後者は待っても絶対に解消しないため、リトライ対象にしないよう
        // クライアント側が判別できる形(429以外のステータス)で返す。
        let errorType: string | undefined;
        try {
          errorType = JSON.parse(errText)?.error?.type;
        } catch {
          // JSONとして解析できなければ無視(下のデフォルト扱いにフォールバック)
        }

        if (errorType === "insufficient_quota") {
          return NextResponse.json(
            {
              error:
                "OpenAI APIのクレジット残高が不足している可能性があります。OpenAIの請求ページ(platform.openai.com/settings/organization/billing)でチャージしてから、再度「判定開始」を押してください。",
              quotaExceeded: true,
            },
            { status: 402 } // 429ではなく402(Payment Required)で返し、クライアント側のリトライ対象から明確に外す
          );
        }

        // それ以外(一時的なレート制限)は、これまで通り429のまま返し、
        // クライアント側の自動リトライ(指数バックオフ)の対象にする。
        return NextResponse.json(
          { error: "OpenAI APIのレート制限が続いたため判定できませんでした。時間をおいて「判定開始」を押すと再試行できます。" },
          { status: 429 }
        );
      }

      return NextResponse.json(
        { error: "AI判定APIの呼び出しに失敗しました。時間を置いて再度お試しください。" },
        { status: 502 }
      );
    }

    const data = await openaiResponse.json();
    const rawText = extractOutputText(data);
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed: JudgeResult;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("JSON parse failed. raw text:", rawText);
      return NextResponse.json(
        { error: "AIの応答を解析できませんでした。もう一度お試しください。" },
        { status: 502 }
      );
    }

    if (!JUDGMENT_VALUES.includes(parsed.judgment)) {
      return NextResponse.json(
        { error: "AIの判定結果が想定外の形式でした。" },
        { status: 502 }
      );
    }

    const usage = extractTokenUsage(data);
    if (usage) {
      // コスト検証用に、判定のたびにコンソールへも出力しておく
      // cachedTokens: システムプロンプトなど繰り返し送信している部分が
      // プロンプトキャッシュとしてどれだけ割引価格で処理されているかの目安
      const cacheRatio =
        usage.cachedTokens && usage.inputTokens > 0
          ? ((usage.cachedTokens / usage.inputTokens) * 100).toFixed(1)
          : "0.0";
      console.log(
        `[judge] input=${usage.inputTokens} (cached=${usage.cachedTokens ?? 0}, ${cacheRatio}%) output=${usage.outputTokens} total=${usage.totalTokens}`
      );
    }
    parsed.usage = usage;

    return NextResponse.json(parsed satisfies JudgeResult);
  } catch (err) {
    console.error("Unexpected error in /api/judge:", err);
    return NextResponse.json(
      { error: "予期しないエラーが発生しました。" },
      { status: 500 }
    );
  }
}
