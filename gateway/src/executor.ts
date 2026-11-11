/**
 * ターンの実行を起動する。
 *
 * - cloudrun-job: Cloud Run Jobs の実行を 1 つ起動する（1 実行 = 1 ターン）。
 *                 HTTP 接続に縛られないので、呼び出し元が切断しても処理は続く。上限は最大 24 時間。
 * - local       : ローカル開発用。Runner の簡易サーバー (POST /v1/jobs) に投げる。
 */
import { GoogleAuth } from "google-auth-library";

export interface StartParams {
  sessionId: string;
  turnId: string;
  turnToken: string;
  callbackUrl: string;
  /** エージェントの実行時間の上限 */
  timeoutMs: number;
}

export interface Executor {
  start(p: StartParams): Promise<void>;
}

/** 復元・保存などエージェント実行以外にかかる時間の余裕 */
const JOB_OVERHEAD_SECONDS = 15 * 60;

class CloudRunJobExecutor implements Executor {
  private auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  /** projects/{p}/locations/{r}/jobs/{name} */
  constructor(private job: string) {}

  async start(p: StartParams) {
    const client = await this.auth.getClient();
    await client.request({
      url: `https://run.googleapis.com/v2/${this.job}:run`,
      method: "POST",
      data: {
        overrides: {
          containerOverrides: [
            {
              env: [
                { name: "SESSION_ID", value: p.sessionId },
                { name: "TURN_ID", value: p.turnId },
                { name: "TURN_TOKEN", value: p.turnToken },
                { name: "CALLBACK_URL", value: p.callbackUrl },
              ],
            },
          ],
          taskCount: 1,
          timeout: `${Math.ceil(p.timeoutMs / 1000) + JOB_OVERHEAD_SECONDS}s`,
        },
      },
    });
  }
}

class LocalExecutor implements Executor {
  constructor(private runnerUrl: string) {}
  async start(p: StartParams) {
    const res = await fetch(`${this.runnerUrl.replace(/\/$/, "")}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    if (!res.ok) throw new Error(`runner rejected job: ${res.status} ${await res.text()}`);
  }
}

export function createExecutor(): Executor {
  if (process.env.EXECUTOR === "local") return new LocalExecutor(process.env.RUNNER_URL ?? "http://localhost:8081");
  const job = process.env.RUNNER_JOB;
  if (!job) throw new Error("RUNNER_JOB (projects/{p}/locations/{r}/jobs/{name}) is required");
  return new CloudRunJobExecutor(job);
}
