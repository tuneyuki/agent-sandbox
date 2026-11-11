/**
 * Runner → Gateway の報告用クライアント。
 *
 * Runner は Firestore に直接触れない（権限を持たない）。ターンの入力の取得、イベントの送信、
 * 完了報告はすべて Gateway の /internal API 経由で行い、そのターン専用のトークンで認証する。
 *
 * イベントには連番 (seq) を振り、まとめて送る。同じ seq の再送は Gateway 側で上書きされる
 * だけなので、通信エラー時はそのまま再送してよい。
 */
import type { StorageSpec } from "./storage.js";

export interface TurnSpec {
  prompt: string;
  claudeSessionId?: string;
  options?: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; systemPrompt?: string };
  storage: StorageSpec;
  /** このターンの実行時間の上限 */
  timeoutMs: number;
}

export interface FinishReport {
  status: "completed" | "failed" | "aborted";
  claudeSessionId?: string;
  /** SDK が返すセッション累計コストの推定値 */
  costUsd?: number;
  text: string;
  filesChanged?: unknown;
  error?: string;
}

const FLUSH_INTERVAL_MS = 300;
const FLUSH_MAX_EVENTS = 100;

export class Callback {
  private seq = 0;
  private buffer: any[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private idToken: { value: string; exp: number } | null = null;
  /** Gateway から中断要求が来たら呼ばれる */
  onCancel: () => void = () => {};

  constructor(
    private baseUrl: string,
    private sessionId: string,
    private turnId: string,
    private turnToken: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, "")}/internal/sessions/${this.sessionId}/turns/${this.turnId}/${path}`;
  }

  /** Cloud Run の IAM 認証が有効な Gateway を呼ぶための ID トークン（GCP 上でのみ） */
  private async authHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "x-turn-token": this.turnToken };
    if (process.env.CALLBACK_USE_ID_TOKEN !== "1") return h;
    if (!this.idToken || this.idToken.exp < Date.now()) {
      const aud = new URL(this.baseUrl).origin;
      const res = await fetch(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(aud)}`,
        { headers: { "Metadata-Flavor": "Google" } },
      );
      if (!res.ok) throw new Error(`id token: ${res.status}`);
      this.idToken = { value: await res.text(), exp: Date.now() + 45 * 60 * 1000 };
    }
    h.authorization = `Bearer ${this.idToken.value}`;
    return h;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(this.url(path), {
          method,
          headers: { "content-type": "application/json", ...(await this.authHeaders()) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.ok) return res.status === 204 ? {} : await res.json();
        // 4xx はリトライしても無駄（トークン失効・ターン終了済みなど）
        if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`${path}: ${res.status} ${await res.text()}`), { fatal: true });
        lastErr = new Error(`${path}: ${res.status}`);
      } catch (e: any) {
        if (e?.fatal) throw e;
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw lastErr;
  }

  getSpec(): Promise<TurnSpec> {
    return this.call("GET", "spec");
  }

  async refreshStorage(): Promise<StorageSpec> {
    return (await this.call("POST", "storage-token")).storage;
  }

  /** イベントを積む。text_delta は連続していれば 1 つにまとめる */
  push(ev: any) {
    const last = this.buffer[this.buffer.length - 1];
    if (ev.type === "text_delta" && last?.type === "text_delta") {
      last.delta += ev.delta;
    } else {
      this.buffer.push({ ...ev, seq: ++this.seq });
    }
    if (this.buffer.length >= FLUSH_MAX_EVENTS) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** 生存報告（イベントが無くても送る）。中断要求の確認も兼ねる */
  heartbeat() {
    this.flush(true);
  }

  flush(force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const events = this.buffer;
    this.buffer = [];
    if (!events.length && !force) return this.chain;
    this.chain = this.chain.then(async () => {
      try {
        const res = await this.call("POST", "events", { events });
        if (res?.cancel) this.onCancel();
      } catch (e) {
        console.error("failed to send events:", e);
        if ((e as any)?.fatal) this.onCancel(); // ターンが既に終わっている・トークン失効
      }
    });
    return this.chain;
  }

  async finish(report: FinishReport): Promise<void> {
    await this.flush();
    await this.call("POST", "finish", { ...report, lastSeq: this.seq });
  }
}
