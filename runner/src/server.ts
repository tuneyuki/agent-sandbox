/**
 * Sandbox Runner: Claude Code を実行する Cloud Run サービス。
 *
 * POST /v1/turn   1 ターン実行し、イベントを NDJSON でストリーミングする。
 * GET  /healthz
 *
 * Cloud Run 側で「認証必須 + Gateway の SA のみ invoker」「concurrency=1」で動かす前提。
 * concurrency=1 なので /sandbox は常に 1 セッションだけが使う。
 */
import express from "express";
import { runTurn, type RunnerEvent } from "./agent.js";
import { resetSandbox, restoreState, saveState } from "./state.js";

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
  state?: { downloadUrl?: string; uploadUrl?: string };
}

app.post("/v1/turn", async (req, res) => {
  const body = req.body as TurnRequest;
  if (!body?.sessionId || typeof body.prompt !== "string" || !body.prompt.trim()) {
    res.status(400).json({ error: "sessionId and prompt are required" });
    return;
  }
  if (busy) {
    // concurrency=1 なら通常起きない。起きたら Gateway にリトライさせる。
    res.status(429).json({ error: "runner busy" });
    return;
  }
  busy = true;

  res.status(200);
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders();

  const send = (ev: RunnerEvent | { type: "state_saved" } | { type: "heartbeat" }) => {
    if (!res.writableEnded) res.write(JSON.stringify(ev) + "\n");
  };

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abortController.abort();
  });
  // 長いツール実行中もプロキシに切られないよう定期的に送る
  const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15_000);

  const loc = { sessionId: body.sessionId, ...body.state };
  let restored = false;
  try {
    await resetSandbox();
    await restoreState(loc);
    restored = true;

    for await (const ev of runTurn({
      prompt: body.prompt,
      claudeSessionId: body.claudeSessionId,
      abortController,
    })) {
      send(ev);
    }
  } catch (err) {
    const message = abortController.signal.aborted
      ? "aborted"
      : err instanceof Error
        ? err.message
        : String(err);
    console.error("turn failed:", err);
    send({ type: "error", message });
  } finally {
    clearInterval(heartbeat);
    // 中断・エラーでも途中までの作業は残す（復元に失敗した場合は上書きしない）
    if (restored) {
      try {
        await saveState(loc);
        send({ type: "state_saved" });
      } catch (err) {
        console.error("save failed:", err);
        send({ type: "error", message: `failed to save state: ${(err as Error).message}` });
      }
    }
    await resetSandbox().catch(() => {});
    busy = false;
    res.end();
  }
});

const port = Number(process.env.PORT ?? 8081);
app.listen(port, () => console.log(`runner listening on :${port}`));
