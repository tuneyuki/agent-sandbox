/**
 * Gateway: チャットボット向けの公開 API。
 *
 *   POST   /api/sessions                 セッション作成
 *   GET    /api/sessions                 自分のセッション一覧
 *   GET    /api/sessions/:id             セッション + 履歴
 *   POST   /api/sessions/:id/messages    メッセージ送信。応答は SSE でストリーミング
 *   DELETE /api/sessions/:id             セッション削除（作業ディレクトリも削除）
 *
 * 認証:
 *   - AUTH_MODE=iap   : Cloud Run の IAP を前提に、x-goog-authenticated-user-email をユーザーとする
 *   - AUTH_MODE=token : Authorization: Bearer <API_TOKEN>（全員 "token-user"）
 *   - AUTH_MODE=none  : ローカル開発用
 */
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createStore, type Session } from "./store.js";
import { callRunner, deleteState, signStateUrls } from "./runner.js";

const store = createStore();
const app = express();
app.use(express.json({ limit: "256kb" }));

const AUTH_MODE = process.env.AUTH_MODE ?? "token";
const API_TOKEN = process.env.API_TOKEN ?? "";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS ?? 20_000);

// ---------------------------------------------------------------- auth

declare module "express-serve-static-core" {
  interface Request {
    user?: string;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requireUser(req: Request, res: Response, next: NextFunction) {
  if (AUTH_MODE === "none") {
    req.user = "local";
  } else if (AUTH_MODE === "iap") {
    const email = req.header("x-goog-authenticated-user-email");
    if (email) req.user = email.replace(/^accounts\.google\.com:/, "");
  } else {
    const m = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
    if (API_TOKEN && m && safeEqual(m[1], API_TOKEN)) req.user = "token-user";
  }
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

async function loadOwnSession(req: Request, res: Response): Promise<Session | null> {
  const s = await store.getSession(String(req.params.id));
  if (!s || s.owner !== req.user) {
    res.status(404).json({ error: "session not found" });
    return null;
  }
  return s;
}

// ---------------------------------------------------------------- routes

const api = express.Router();
api.use(requireUser);

api.post("/sessions", async (req, res) => {
  const title = String(req.body?.title ?? "New chat").slice(0, 100);
  res.status(201).json(await store.createSession(req.user!, title));
});

api.get("/sessions", async (req, res) => {
  res.json(await store.listSessions(req.user!));
});

api.get("/sessions/:id", async (req, res) => {
  const s = await loadOwnSession(req, res);
  if (!s) return;
  res.json({ session: s, messages: await store.listMessages(s.id) });
});

api.delete("/sessions/:id", async (req, res) => {
  const s = await loadOwnSession(req, res);
  if (!s) return;
  await deleteState(s.id);
  await store.deleteSession(s.id);
  res.status(204).end();
});

api.post("/sessions/:id/messages", async (req, res) => {
  const s = await loadOwnSession(req, res);
  if (!s) return;
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  if (text.length > MAX_PROMPT_CHARS) {
    res.status(413).json({ error: "text too long" });
    return;
  }
  if (!(await store.tryLock(s.id, TURN_TIMEOUT_MS + 60_000))) {
    res.status(409).json({ error: "this session is already running a turn" });
    return;
  }

  await store.addMessage(s.id, { role: "user", text });

  // SSE
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  const sse = (ev: any) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const events: any[] = [];
  const texts: string[] = [];
  let claudeSessionId: string | undefined;
  let costUsd = 0;

  try {
    const state = await signStateUrls(s.id, TURN_TIMEOUT_MS + 10 * 60_000);
    for await (const ev of callRunner(
      { sessionId: s.id, prompt: text, claudeSessionId: s.claudeSessionId, state },
      abort.signal,
    )) {
      if (ev.type === "heartbeat") {
        res.write(": ping\n\n");
        continue;
      }
      if (ev.type === "session") claudeSessionId = ev.claudeSessionId;
      if (ev.type === "text") texts.push(ev.text);
      if (ev.type === "result") costUsd = Number(ev.costUsd ?? 0);
      if (ev.type !== "state_saved") events.push(ev);
      sse(ev);
    }
  } catch (err) {
    const message = abort.signal.aborted ? "aborted or timed out" : (err as Error).message;
    console.error("turn error:", err);
    events.push({ type: "error", message });
    sse({ type: "error", message });
  } finally {
    clearTimeout(timer);
    // total_cost_usd は resume したセッションの累計なので、前回からの差分を加算する
    const prevCost = s.totalCostUsd ?? 0;
    const delta = costUsd > prevCost ? costUsd - prevCost : 0;
    await store
      .addMessage(s.id, { role: "assistant", text: texts.join("\n\n"), events })
      .catch((e) => console.error(e));
    await store
      .unlock(s.id, { claudeSessionId: claudeSessionId ?? s.claudeSessionId, addCostUsd: delta })
      .catch((e) => console.error(e));
    sse({ type: "done" });
    res.end();
  }
});

app.use("/api", api);
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// チャット UI（静的ファイル）
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "..", "public")));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`gateway listening on :${port} (auth=${AUTH_MODE})`));
