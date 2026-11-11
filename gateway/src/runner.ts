/**
 * Gateway → Runner の呼び出しと、状態保存用の GCS 署名付き URL の発行。
 */
import { GoogleAuth } from "google-auth-library";
import { Storage } from "@google-cloud/storage";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://localhost:8081";
/** Cloud Run の認証付きサービスを呼ぶときは true（ID トークンを付与） */
const RUNNER_AUTH = process.env.RUNNER_AUTH !== "none";
const STATE_BUCKET = process.env.STATE_BUCKET;

const auth = new GoogleAuth();
const storage = STATE_BUCKET ? new Storage() : null;

export function stateObjectName(sessionId: string): string {
  return `sessions/${sessionId}/state.tar.gz`;
}

/**
 * Runner に渡す署名付き URL。Runner の SA にはバケット権限を付けず、
 * そのターンのそのセッションのオブジェクトだけを一時的に読み書きさせる。
 */
export async function signStateUrls(
  sessionId: string,
  ttlMs: number,
): Promise<{ downloadUrl?: string; uploadUrl?: string }> {
  if (!storage || !STATE_BUCKET) return {};
  const file = storage.bucket(STATE_BUCKET).file(stateObjectName(sessionId));
  const expires = Date.now() + ttlMs;
  const [[downloadUrl], [uploadUrl]] = await Promise.all([
    file.getSignedUrl({ version: "v4", action: "read", expires }),
    file.getSignedUrl({ version: "v4", action: "write", expires, contentType: "application/gzip" }),
  ]);
  return { downloadUrl, uploadUrl };
}

export async function deleteState(sessionId: string): Promise<void> {
  if (!storage || !STATE_BUCKET) return;
  await storage
    .bucket(STATE_BUCKET)
    .file(stateObjectName(sessionId))
    .delete({ ignoreNotFound: true });
}

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
  state: { downloadUrl?: string; uploadUrl?: string };
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
