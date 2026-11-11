/**
 * 1 ターン分の処理。Cloud Run Jobs の 1 実行 = 1 ターン。
 *
 *   1. Gateway からターンの入力（プロンプト・オプション・ストレージ用トークン）を取得
 *   2. /sandbox を空にし、セッションフォルダから workspace・依存・会話記録を復元
 *   3. Claude Code を実行し、イベントを Gateway に送る
 *   4. 残ったプロセスを止め、変更を書き戻し、完了を報告
 *
 * HTTP 接続に依存しないので、呼び出し元が切断しても処理は続く。
 */
import os from "node:os";
import { runTurn } from "./agent.js";
import { Callback, type FinishReport } from "./callback.js";
import { configurePackageMirrors } from "./packages.js";
import { killStrayProcesses } from "./processes.js";
import { createObjectStore } from "./storage.js";
import { resetSandbox, restore, save, SANDBOX_ROOT, type Manifest } from "./sync.js";

export interface JobParams {
  callbackUrl: string;
  sessionId: string;
  turnId: string;
  turnToken: string;
}

const HEARTBEAT_MS = 20_000;

export async function runJob(p: JobParams): Promise<void> {
  const cb = new Callback(p.callbackUrl, p.sessionId, p.turnId, p.turnToken);
  const abortController = new AbortController();
  let abortReason: "cancelled" | "timeout" | null = null;
  cb.onCancel = () => {
    if (!abortReason) abortReason = "cancelled";
    abortController.abort();
  };

  const report: FinishReport = { status: "failed", text: "" };
  const texts: string[] = [];
  let manifest: Manifest | null = null;
  let timer: NodeJS.Timeout | undefined;

  const spec = await cb.getSpec();
  const store = createObjectStore(spec.storage, () => cb.refreshStorage());
  const prefix = `sessions/${p.sessionId}/`;
  report.claudeSessionId = spec.claudeSessionId;
  const heartbeat = setInterval(() => cb.heartbeat(), HEARTBEAT_MS);

  try {
    timer = setTimeout(() => {
      abortReason = "timeout";
      abortController.abort();
    }, spec.timeoutMs);

    await resetSandbox();
    cb.push({ type: "status", status: "restoring" });
    manifest = await restore(store, prefix);
    const extraEnv = await configurePackageMirrors(process.env.HOME ?? os.homedir());
    cb.push({ type: "status", status: "running" });

    for await (const ev of runTurn({
      prompt: spec.prompt,
      claudeSessionId: spec.claudeSessionId,
      ...spec.options,
      extraEnv,
      abortController,
    })) {
      if (ev.type === "session") {
        report.claudeSessionId = ev.claudeSessionId;
        continue; // 内部 ID は外に出さない
      }
      if (ev.type === "text") texts.push(ev.text);
      if (ev.type === "result") {
        report.costUsd = ev.costUsd;
        report.status = ev.ok ? "completed" : "failed";
        if (!ev.ok) report.error = ev.subtype;
      }
      cb.push(ev);
    }
  } catch (err) {
    const message = abortReason ?? (err instanceof Error ? err.message : String(err));
    console.error("turn failed:", err);
    report.error = message;
    cb.push({ type: "error", message });
  } finally {
    clearTimeout(timer);
    if (abortReason) {
      report.status = "aborted";
      report.error = abortReason;
    }
    // エージェントが起動したまま残したプロセス（サーバー等）を止めてから保存する
    const killed = await killStrayProcesses(SANDBOX_ROOT).catch(() => 0);
    if (killed) console.log(`killed ${killed} stray process(es)`);
    if (manifest) {
      try {
        cb.push({ type: "status", status: "saving" });
        const changes = await save(store, prefix, manifest);
        report.filesChanged = changes;
        cb.push({ type: "files_changed", ...changes });
      } catch (err) {
        console.error("save failed:", err);
        report.status = "failed";
        report.error = `failed to save workspace: ${(err as Error).message}`;
        cb.push({ type: "error", message: report.error });
      }
    }
    clearInterval(heartbeat);
    report.text = texts.join("\n\n");
    await cb.finish(report).catch((e) => console.error("finish failed:", e));
    await resetSandbox().catch(() => {});
  }
}
