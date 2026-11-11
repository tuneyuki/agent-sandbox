/**
 * Sandbox Runner: Claude Code を実行する Cloud Run サービス（内部専用）。
 *
 * POST /v1/turn   1 ターン実行し、イベントを NDJSON でストリーミングする。
 * GET  /healthz
 *
 * 状態は一切持たない。毎ターン:
 *   1. /sandbox を空にする
 *   2. セッションフォルダ (sessions/{id}/) から workspace と会話記録を復元
 *   3. Claude Code を実行
 *   4. 変更分を書き戻し、/sandbox を空にする
 * Cloud Run 側は「concurrency=1」「Gateway の SA だけが invoker」で動かす。
 */
import express from "express";
import { runTurn, type RunnerEvent, type TurnInput } from "./agent.js";
import { createObjectStore, type StorageSpec } from "./storage.js";
import { configurePackageMirrors } from "./packages.js";
import { killStrayProcesses } from "./processes.js";
import { resetSandbox, restore, save, SANDBOX_ROOT, type SyncResult } from "./sync.js";
import os from "node:os";

const app = express();
app.use(express.json({ limit: "1mb" }));

let busy = false;

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, busy });
});

interface TurnRequest {
  sessionId: string;
  prompt: string;
  claudeSessionId?: string;
  storage: StorageSpec;
  options?: Pick<TurnInput, "model" | "effort" | "systemPrompt">;
}

type OutEvent =
  | RunnerEvent
  | { type: "status"; status: string }
  | ({ type: "files_changed" } & SyncResult)
  | { type: "heartbeat" };

app.post("/v1/turn", async (req, res) => {
  const body = req.body as TurnRequest;
  if (!body?.sessionId || !/^[A-Za-z0-9_-]+$/.test(body.sessionId) || !body.prompt?.trim() || !body.storage) {
    res.status(400).json({ error: "sessionId, prompt and storage are required" });
    return;
  }
  if (busy) {
    res.status(429).json({ error: "runner busy" });
    return;
  }
  busy = true;

  res.status(200);
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders();
  const send = (ev: OutEvent) => {
    if (!res.writableEnded) res.write(JSON.stringify(ev) + "\n");
  };

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abortController.abort();
  });
  const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15_000);

  const store = createObjectStore(body.storage);
  const prefix = `sessions/${body.sessionId}/`;
  let manifest: Awaited<ReturnType<typeof restore>> | null = null;

  try {
    await resetSandbox();
    send({ type: "status", status: "restoring" });
    manifest = await restore(store, prefix);
    const extraEnv = await configurePackageMirrors(process.env.HOME ?? os.homedir());
    send({ type: "status", status: "running" });

    for await (const ev of runTurn({
      prompt: body.prompt,
      claudeSessionId: body.claudeSessionId,
      ...body.options,
      extraEnv,
      abortController,
    })) {
      send(ev);
    }
  } catch (err) {
    const message = abortController.signal.aborted ? "aborted" : err instanceof Error ? err.message : String(err);
    console.error("turn failed:", err);
    send({ type: "error", message });
  } finally {
    clearInterval(heartbeat);
    // エージェントが起動したまま残したプロセス（サーバー等）を止めてから保存する
    const killed = await killStrayProcesses(SANDBOX_ROOT).catch(() => 0);
    if (killed) console.log(`killed ${killed} stray process(es)`);
    // 中断・エラーでも途中までの成果は残す（復元に失敗した場合は書き戻さない）
    if (manifest) {
      try {
        send({ type: "status", status: "saving" });
        send({ type: "files_changed", ...(await save(store, prefix, manifest)) });
      } catch (err) {
        console.error("save failed:", err);
        send({ type: "error", message: `failed to save workspace: ${(err as Error).message}` });
      }
    }
    await resetSandbox().catch(() => {});
    busy = false;
    res.end();
  }
});

const port = Number(process.env.PORT ?? 8081);
app.listen(port, () => console.log(`runner listening on :${port}`));
