/**
 * Gateway: チャットボットのバックエンド（BFF）から呼ばれる Agent Sandbox API。
 *
 * セッション
 *   POST   /v1/sessions                              作成
 *   GET    /v1/sessions                              一覧（x-user-id ごと）
 *   GET    /v1/sessions/:id                          セッション + ターン一覧
 *   DELETE /v1/sessions/:id                          削除（フォルダごと）
 * ファイル（セッションフォルダの workspace/ 配下）
 *   GET    /v1/sessions/:id/files                    一覧
 *   POST   /v1/sessions/:id/files                    JSON で一括アップロード
 *   PUT    /v1/sessions/:id/files/<path>             生バイナリでアップロード
 *   GET    /v1/sessions/:id/files/<path>             ダウンロード
 *   DELETE /v1/sessions/:id/files/<path>             削除
 * 実行
 *   POST   /v1/sessions/:id/messages                 指示を送る。既定は SSE、{ "async": true } なら 202
 *   GET    /v1/sessions/:id/turns/:turnId            ターンの状態
 *   GET    /v1/sessions/:id/turns/:turnId/events     イベント（SSE。Last-Event-ID / ?after= で途中から）
 *   POST   /v1/sessions/:id/turns/:turnId/cancel     中断
 *
 * 内部（Runner からの報告。ターン専用トークンで認証）
 *   GET    /internal/sessions/:id/turns/:turnId/spec
 *   POST   /internal/sessions/:id/turns/:turnId/events
 *   POST   /internal/sessions/:id/turns/:turnId/storage-token
 *   POST   /internal/sessions/:id/turns/:turnId/finish
 *
 * 認証（AUTH_MODE）: iam（Cloud Run の IAM） / token（Bearer） / none（ローカル）。
 * エンドユーザーは、認証済みの呼び出し元が付ける x-user-id で区別する。
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createStore, TERMINAL, type Session, type StoredEvent, type Turn } from "./store.js";
import { createSessionFiles, normalizeFilePath } from "./storage.js";
import { createExecutor } from "./executor.js";

const store = createStore();
const files = createSessionFiles();
const executor = createExecutor();
const app = express();
app.set("trust proxy", true);

const AUTH_MODE = process.env.AUTH_MODE ?? "iam";
const API_TOKEN = process.env.API_TOKEN ?? "";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 30 * 60 * 1000);
/** ジョブ起動から最初の生存報告までの猶予（コールドスタート込み） */
const START_GRACE_MS = Number(process.env.START_GRACE_MS ?? 10 * 60 * 1000);
/** 生存報告が途絶えてから失敗扱いにするまで */
const HEARTBEAT_GRACE_MS = Number(process.env.HEARTBEAT_GRACE_MS ?? 3 * 60 * 1000);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS ?? 100_000);
const MAX_UPLOAD_BYTES = process.env.MAX_UPLOAD_BYTES ?? "100mb";
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** 全体で同時に実行するターン数の上限（0 なら無制限）。コストの歯止め */
const MAX_RUNNING_TURNS = Number(process.env.MAX_RUNNING_TURNS ?? 0);

const jsonSmall = express.json({ limit: "1mb" });
const jsonLarge = express.json({ limit: MAX_UPLOAD_BYTES });

declare module "express-serve-static-core" {
  interface Request {
    user?: string;
    session_?: Session;
    turn?: Turn;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** 外に返すターン情報（トークンのハッシュなどは除く） */
function publicTurn(t: Turn) {
  const { tokenHash: _h, prompt: _p, ...rest } = t;
  return rest;
}

function fileUrl(sessionId: string, p: string) {
  return `/v1/sessions/${sessionId}/files/${p.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------------------------------------------------------------- public auth

function authenticate(req: Request, res: Response, next: NextFunction) {
  if (AUTH_MODE === "token") {
    const m = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
    if (!API_TOKEN || !m || !safeEqual(m[1], API_TOKEN)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  req.user = (req.header("x-user-id") || "default").slice(0, 256);
  next();
}

async function ownSession(req: Request, res: Response): Promise<Session | null> {
  const id = String(req.params.id);
  const s = /^[A-Za-z0-9]+$/.test(id) ? await store.getSession(id) : null;
  if (!s || s.owner !== req.user) {
    res.status(404).json({ error: "session not found" });
    return null;
  }
  return s;
}

async function ownTurn(req: Request, res: Response): Promise<{ s: Session; t: Turn } | null> {
  const s = await ownSession(req, res);
  if (!s) return null;
  const tid = String(req.params.turnId);
  const t = /^[A-Za-z0-9]+$/.test(tid) ? await store.getTurn(s.id, tid) : null;
  if (!t) {
    res.status(404).json({ error: "turn not found" });
    return null;
  }
  return { s, t };
}

/** 実行中はファイルを変更させない（Runner の書き戻しと衝突するため） */
async function ownIdleSession(req: Request, res: Response): Promise<Session | null> {
  const s = await ownSession(req, res);
  if (!s) return null;
  await store.reapStale(s.id);
  const fresh = (await store.getSession(s.id))!;
  if (fresh.status === "running") {
    res.status(409).json({ error: "session is running; try again after the turn finishes" });
    return null;
  }
  return fresh;
}

function filePathParam(req: Request): string | null {
  const raw = (req.params as any).path;
  return normalizeFilePath(Array.isArray(raw) ? raw.join("/") : String(raw ?? ""));
}

function decodeData(data: string): Buffer {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(data);
  if (m) return m[1] ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]));
  return Buffer.from(data, "base64");
}

interface UploadItem {
  path?: string;
  filename?: string;
  data: string;
  content_type?: string;
}

function uploadPath(it: UploadItem): string {
  const name = it.path ?? (it.filename ? `uploads/${path.posix.basename(it.filename)}` : "");
  const p = normalizeFilePath(name);
  if (!p || typeof it.data !== "string") throw Object.assign(new Error(`invalid file: ${name}`), { status: 400 });
  return p;
}

async function saveUploads(sessionId: string, items: UploadItem[]): Promise<string[]> {
  const saved: string[] = [];
  for (const it of items) {
    const p = uploadPath(it);
    await files.write(sessionId, p, decodeData(it.data), it.content_type);
    saved.push(p);
  }
  return saved;
}

// ---------------------------------------------------------------- SSE

function startSse(res: Response) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");
}

/**
 * ターンのイベントを SSE で流す。done イベントで終わる。
 * 接続が切れてもターンは止まらない（再接続は Last-Event-ID で続きから）。
 */
function streamTurn(req: Request, res: Response, sessionId: string, turnId: string, afterSeq: number) {
  let closed = false;
  const write = (e: StoredEvent) => {
    if (closed) return;
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    if (e.type === "done") finish();
  };
  const unsubscribe = store.watchEvents(sessionId, turnId, afterSeq, (evs) => evs.forEach(write));
  const ping = setInterval(() => !closed && res.write(": ping\n\n"), 15_000);
  // Runner が落ちていたら失敗として done を書く（watch 経由で届いて終わる）
  const reaper = setInterval(() => store.reapStale(sessionId).catch((e) => console.error(e)), 30_000);
  function finish() {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(ping);
    clearInterval(reaper);
    res.end();
  }
  req.on("close", finish);
}

// ---------------------------------------------------------------- sessions

const v1 = express.Router();
v1.use(authenticate);

v1.post(
  "/sessions",
  jsonSmall,
  wrap(async (req, res) => {
    const title = String(req.body?.title ?? "New session").slice(0, 200);
    res.status(201).json(await store.createSession(req.user!, title));
  }),
);

v1.get(
  "/sessions",
  wrap(async (req, res) => {
    res.json(await store.listSessions(req.user!));
  }),
);

v1.get(
  "/sessions/:id",
  wrap(async (req, res) => {
    const s = await ownSession(req, res);
    if (!s) return;
    await store.reapStale(s.id);
    res.json({ session: await store.getSession(s.id), turns: (await store.listTurns(s.id)).map(publicTurn) });
  }),
);

v1.delete(
  "/sessions/:id",
  wrap(async (req, res) => {
    const s = await ownIdleSession(req, res);
    if (!s) return;
    await files.removeSession(s.id);
    await store.deleteSession(s.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- files

v1.get(
  "/sessions/:id/files",
  wrap(async (req, res) => {
    const s = await ownSession(req, res);
    if (s) res.json(await files.list(s.id));
  }),
);

v1.post(
  "/sessions/:id/files",
  jsonLarge,
  wrap(async (req, res) => {
    const s = await ownIdleSession(req, res);
    if (!s) return;
    const items: UploadItem[] = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!items.length) {
      res.status(400).json({ error: "files is required" });
      return;
    }
    res.status(201).json({ saved: await saveUploads(s.id, items) });
  }),
);

v1.put(
  "/sessions/:id/files/*path",
  wrap(async (req, res) => {
    const s = await ownIdleSession(req, res);
    if (!s) return;
    const p = filePathParam(req);
    if (!p) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    await files.write(s.id, p, req, req.header("content-type") || undefined);
    res.status(201).json({ path: p });
  }),
);

v1.get(
  "/sessions/:id/files/*path",
  wrap(async (req, res) => {
    const s = await ownSession(req, res);
    if (!s) return;
    const p = filePathParam(req);
    const f = p ? await files.read(s.id, p) : null;
    if (!f) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    res.setHeader("content-type", f.contentType || "application/octet-stream");
    res.setHeader("content-length", String(f.size));
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p!))}`);
    f.stream.on("error", (e) => res.destroy(e)).pipe(res);
  }),
);

v1.delete(
  "/sessions/:id/files/*path",
  wrap(async (req, res) => {
    const s = await ownIdleSession(req, res);
    if (!s) return;
    const p = filePathParam(req);
    if (!p || !(await files.remove(s.id, p))) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- turns

v1.post(
  "/sessions/:id/messages",
  jsonLarge,
  wrap(async (req, res) => {
    const s = await ownSession(req, res);
    if (!s) return;

    const input = String(req.body?.input ?? "").trim();
    const uploads: UploadItem[] = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!input && !uploads.length) {
      res.status(400).json({ error: "input is required" });
      return;
    }
    if (input.length > MAX_PROMPT_CHARS) {
      res.status(413).json({ error: "input too long" });
      return;
    }
    const attachments = uploads.map(uploadPath);
    const options = {
      model: ALLOWED_MODELS.includes(req.body?.model) ? String(req.body.model) : undefined,
      effort: EFFORTS.includes(req.body?.effort) ? String(req.body.effort) : undefined,
      systemPrompt: req.body?.system_prompt ? String(req.body.system_prompt).slice(0, 20_000) : undefined,
    };
    const prompt = attachments.length
      ? `ユーザーが次のファイルを添付しました（作業ディレクトリからの相対パス）:\n${attachments
          .map((a) => `- ${a}`)
          .join("\n")}\n\n${input || "添付ファイルを確認してください。"}`
      : input;

    if (MAX_RUNNING_TURNS > 0 && (await store.countRunning()) >= MAX_RUNNING_TURNS) {
      res.status(429).setHeader("retry-after", "30").json({ error: "too many running turns; try again later" });
      return;
    }
    const turnToken = randomBytes(32).toString("hex");
    const turn = await store.beginTurn(
      s.id,
      { input, attachments, prompt, options, tokenHash: sha256(turnToken) },
      START_GRACE_MS,
    );
    if (!turn) {
      res.status(409).json({ error: "this session is already running a turn" });
      return;
    }

    try {
      await saveUploads(s.id, uploads);
      await executor.start({
        sessionId: s.id,
        turnId: turn.id,
        turnToken,
        callbackUrl: process.env.CALLBACK_URL || `${req.protocol}://${req.get("host")}`,
        timeoutMs: TURN_TIMEOUT_MS,
      });
    } catch (e) {
      console.error("failed to start turn:", e);
      await store.finishTurn(s.id, turn.id, { status: "failed", error: `failed to start: ${(e as Error).message}`, lastSeq: 0 });
      res.status((e as any)?.status ?? 502).json({ error: (e as Error).message, turn_id: turn.id });
      return;
    }

    const head = { session_id: s.id, turn_id: turn.id, attachments };
    const eventsUrl = `/v1/sessions/${s.id}/turns/${turn.id}/events`;
    if (req.body?.async === true) {
      res.status(202).json({ ...head, status: turn.status, events_url: eventsUrl, turn_url: `/v1/sessions/${s.id}/turns/${turn.id}` });
      return;
    }
    startSse(res);
    res.write(`data: ${JSON.stringify({ type: "session", ...head, events_url: eventsUrl })}\n\n`);
    streamTurn(req, res, s.id, turn.id, 0);
  }),
);

v1.get(
  "/sessions/:id/turns",
  wrap(async (req, res) => {
    const s = await ownSession(req, res);
    if (s) res.json((await store.listTurns(s.id)).map(publicTurn));
  }),
);

v1.get(
  "/sessions/:id/turns/:turnId",
  wrap(async (req, res) => {
    const st = await ownTurn(req, res);
    if (!st) return;
    await store.reapStale(st.s.id);
    res.json(publicTurn((await store.getTurn(st.s.id, st.t.id))!));
  }),
);

v1.get(
  "/sessions/:id/turns/:turnId/events",
  wrap(async (req, res) => {
    const st = await ownTurn(req, res);
    if (!st) return;
    const after = Number(req.header("last-event-id") ?? req.query.after ?? 0) || 0;
    if (req.query.stream === "false") {
      res.json(await store.listEvents(st.s.id, st.t.id, after));
      return;
    }
    startSse(res);
    streamTurn(req, res, st.s.id, st.t.id, after);
  }),
);

v1.post(
  "/sessions/:id/turns/:turnId/cancel",
  wrap(async (req, res) => {
    const st = await ownTurn(req, res);
    if (!st) return;
    if (TERMINAL.includes(st.t.status)) {
      res.status(409).json({ error: `turn already ${st.t.status}` });
      return;
    }
    await store.requestCancel(st.s.id, st.t.id);
    res.status(202).json({ cancel_requested: true });
  }),
);

// ---------------------------------------------------------------- internal (runner → gateway)

/** Runner からの呼び出しを、そのターン専用のトークンで認証する */
const internalAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.header("x-turn-token") ?? "";
    const t = await store.getTurn(String(req.params.id), String(req.params.turnId));
    if (!t || !token || !safeEqual(sha256(token), t.tokenHash)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (TERMINAL.includes(t.status)) {
      res.status(410).json({ error: `turn already ${t.status}` });
      return;
    }
    req.turn = t;
    next();
  } catch (e) {
    next(e);
  }
};

const ip = "/internal/sessions/:id/turns/:turnId";

app.get(
  `${ip}/spec`,
  internalAuth,
  wrap(async (req, res) => {
    const t = req.turn!;
    const s = (await store.getSession(t.sessionId))!;
    await store.heartbeat(s.id, t.id, HEARTBEAT_GRACE_MS);
    res.json({
      prompt: t.prompt,
      claudeSessionId: s.claudeSessionId,
      options: t.options,
      storage: await files.runnerStorageSpec(s.id),
      timeoutMs: TURN_TIMEOUT_MS,
    });
  }),
);

app.post(
  `${ip}/storage-token`,
  internalAuth,
  wrap(async (req, res) => {
    res.json({ storage: await files.runnerStorageSpec(req.turn!.sessionId) });
  }),
);

app.post(
  `${ip}/events`,
  jsonLarge,
  internalAuth,
  wrap(async (req, res) => {
    const t = req.turn!;
    const events: StoredEvent[] = (Array.isArray(req.body?.events) ? req.body.events : [])
      .filter((e: any) => Number.isInteger(e?.seq) && e.seq > 0 && e.type !== "done")
      .map((e: any) => {
        if (e.type !== "files_changed") return e;
        const withUrl = (xs: any[] = []) => xs.map((x) => ({ ...x, url: fileUrl(t.sessionId, x.path) }));
        return { ...e, added: withUrl(e.added), modified: withUrl(e.modified) };
      });
    if (events.length) await store.appendEvents(t.sessionId, t.id, events);
    const hb = await store.heartbeat(t.sessionId, t.id, HEARTBEAT_GRACE_MS);
    res.json({ cancel: hb.cancel || !hb.active });
  }),
);

app.post(
  `${ip}/finish`,
  jsonLarge,
  internalAuth,
  wrap(async (req, res) => {
    const t = req.turn!;
    const b = req.body ?? {};
    const status = ["completed", "failed", "aborted"].includes(b.status) ? b.status : "failed";
    const withUrl = (xs: any[] = []) => xs.map((x) => ({ ...x, url: fileUrl(t.sessionId, x.path) }));
    const fc = b.filesChanged
      ? { ...b.filesChanged, added: withUrl(b.filesChanged.added), modified: withUrl(b.filesChanged.modified) }
      : undefined;
    await store.finishTurn(t.sessionId, t.id, {
      status,
      text: typeof b.text === "string" ? b.text : "",
      filesChanged: fc,
      error: b.error ? String(b.error) : undefined,
      cumulativeCostUsd: typeof b.costUsd === "number" ? b.costUsd : undefined,
      claudeSessionId: typeof b.claudeSessionId === "string" ? b.claudeSessionId : undefined,
      lastSeq: Number(b.lastSeq) || 0,
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- app

app.use("/v1", v1);
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err?.status ?? (err?.type === "entity.too.large" ? 413 : 500)).json({ error: err?.message ?? "error" });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`gateway listening on :${port} (auth=${AUTH_MODE})`));
