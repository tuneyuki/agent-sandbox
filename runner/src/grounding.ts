/**
 * Gemini の Google Search grounding を Claude Code のツールとして提供する。
 *
 * サンドボックスはインターネットに出られないが、Vertex AI (aiplatform.googleapis.com) には
 * Private Google Access で届く。検索は Google 側で行われるので、サンドボックスから任意の
 * サイトへは接続しないまま「Web を調べる」能力だけを渡せる。
 *
 * - ツール名（Claude から見える名前）: mcp__web__google_search
 * - URL を指定して読む機能（Gemini の URL context）は付けない。任意の URL への送信経路になるため。
 *
 * 設定（環境変数）
 *   GROUNDING_ENABLED=1
 *   GROUNDING_MODEL       既定 gemini-2.5-flash
 *   GROUNDING_PROJECT     既定 ANTHROPIC_VERTEX_PROJECT_ID
 *   GROUNDING_LOCATION    既定 global
 *   GROUNDING_MAX_CALLS   1 ターンあたりの呼び出し上限（既定 20）
 *   GEMINI_API_KEY        ローカル開発用。設定すると Vertex ではなく Gemini API を使う
 *   GROUNDING_ENDPOINT    エンドポイントの上書き（テスト用）
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

export const GROUNDING_TOOL = "mcp__web__google_search";

export const groundingEnabled = () => process.env.GROUNDING_ENABLED === "1";

const MODEL = process.env.GROUNDING_MODEL || "gemini-2.5-flash";
const LOCATION = process.env.GROUNDING_LOCATION || "global";
const MAX_CALLS = Number(process.env.GROUNDING_MAX_CALLS ?? 20);
const TIMEOUT_MS = 90_000;

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

interface GroundedAnswer {
  text: string;
  sources: { title?: string; uri?: string }[];
  queries: string[];
}

async function callGemini(query: string): Promise<GroundedAnswer> {
  const apiKey = process.env.GEMINI_API_KEY;
  const project = process.env.GROUNDING_PROJECT || process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;

  const url =
    process.env.GROUNDING_ENDPOINT ||
    (apiKey
      ? `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
      : `https://${host}/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-goog-api-key"] = apiKey;
  else if (!process.env.GROUNDING_ENDPOINT) {
    if (!project) throw new Error("GROUNDING_PROJECT (or ANTHROPIC_VERTEX_PROJECT_ID) is not set");
    headers.authorization = `Bearer ${await auth.getAccessToken()}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
      systemInstruction: {
        parts: [
          {
            text:
              "Google 検索で調べた結果に基づいて、質問に事実ベースで簡潔に答えてください。" +
              "日付・バージョン・数値は出典どおりに書き、分からないことは分からないと書いてください。",
          },
        ],
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as any;
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .map((p: any) => p.text ?? "")
    .join("")
    .trim();
  const meta = cand?.groundingMetadata ?? {};
  const sources = (meta.groundingChunks ?? [])
    .map((c: any) => c.web)
    .filter(Boolean)
    .map((w: any) => ({ title: w.title, uri: w.uri }));
  return { text, sources, queries: meta.webSearchQueries ?? [] };
}

/** ターンごとに作る（呼び出し回数の上限をターン単位で数えるため） */
export function createGroundingServer() {
  let calls = 0;
  return createSdkMcpServer({
    name: "web",
    version: "1.0.0",
    instructions:
      "このサンドボックスはインターネットに直接接続できません。最新情報・ドキュメント・ニュースなど Web の情報が必要なときは google_search ツールを使ってください。",
    tools: [
      tool(
        "google_search",
        "Google 検索で Web を調べ、検索結果に基づく回答と出典 URL を返す（Gemini の Google Search grounding）。" +
          "最新のライブラリのバージョン、API の使い方、エラーメッセージの意味、ニュースなどを調べるのに使う。" +
          "query には調べたいことを具体的な質問文で書く（例:「FastAPI 0.115 で lifespan イベントを書く方法」）。" +
          "任意の URL のページを取得する機能はない。",
        { query: z.string().min(1).max(2000).describe("調べたいことを具体的に書いた質問文") },
        async ({ query }) => {
          if (++calls > MAX_CALLS) {
            return {
              isError: true,
              content: [{ type: "text", text: `このターンの検索回数の上限（${MAX_CALLS} 回）に達しました。` }],
            };
          }
          try {
            const a = await callGemini(query);
            const sources = a.sources.length
              ? "\n\n出典:\n" + a.sources.map((s, i) => `[${i + 1}] ${s.title ?? ""} ${s.uri ?? ""}`.trim()).join("\n")
              : "\n\n（出典なし: 検索結果に基づかない回答の可能性があります）";
            const queries = a.queries.length ? `\n\n検索クエリ: ${a.queries.join(" / ")}` : "";
            return { content: [{ type: "text", text: (a.text || "（回答なし）") + sources + queries }] };
          } catch (e) {
            return { isError: true, content: [{ type: "text", text: `検索に失敗しました: ${(e as Error).message}` }] };
          }
        },
        // 毎回 ToolSearch で探させず、最初からツール一覧に載せる
        { annotations: { readOnlyHint: true, openWorldHint: true }, alwaysLoad: true },
      ),
    ],
  });
}
