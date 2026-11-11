/**
 * Gateway → Runner の呼び出し（Cloud Run の ID トークン認証、NDJSON ストリーム）。
 */
import { GoogleAuth } from "google-auth-library";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://localhost:8081";
/** Cloud Run の認証付きサービスを呼ぶときは ID トークンを付与 */
const RUNNER_AUTH = process.env.RUNNER_AUTH !== "none";

const auth = new GoogleAuth();

async function authHeaders(): Promise<Record<string, string>> {
  if (!RUNNER_AUTH) return {};
  const client = await auth.getIdTokenClient(RUNNER_URL);
  const headers: any = await client.getRequestHeaders(RUNNER_URL);
  // google-auth-library v10 は Headers、それ以前はプレーンオブジェクトを返す
  return headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
}

export interface TurnRequest {
  sessionId: string;
  prompt: string;
  claudeSessionId?: string;
  storage: { type: "gcs"; bucket: string; accessToken: string } | { type: "local" };
  options?: { model?: string; effort?: string; systemPrompt?: string };
}

/** Runner の NDJSON ストリームを 1 イベントずつ返す。 */
export async function* callRunner(req: TurnRequest, signal: AbortSignal): AsyncGenerator<any> {
  let res: Response | undefined;
  // Runner が busy (429) のときは少し待ってリトライ（Cloud Run が別インスタンスに振る）
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(`${RUNNER_URL}/v1/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(req),
      signal,
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (!res || !res.ok || !res.body) {
    throw new Error(`runner error: ${res?.status} ${res ? await res.text() : ""}`);
  }

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}
