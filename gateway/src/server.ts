/**
 * Gateway: チャットボットのバックエンド（BFF）から呼ばれる Agent Sandbox API。
 *
 * セッション
 *   POST   /v1/sessions                        セッション作成 → { id, ... }
 *   GET    /v1/sessions                        一覧（x-user-id ごと）
 *   GET    /v1/sessions/:id                    セッション + ターン履歴
 *   DELETE /v1/sessions/:id                    セッション削除（フォルダごと消える）
 * ファイル（セッションフォルダの workspace/ 配下）
 *   GET    /v1/sessions/:id/files              一覧
 *   POST   /v1/sessions/:id/files              JSON で一括アップロード { files: [{ path?, filename, data }] }
 *   PUT    /v1/sessions/:id/files/<path>       生バイナリでアップロード
 *   GET    /v1/sessions/:id/files/<path>       ダウンロード
 *   DELETE /v1/sessions/:id/files/<path>       削除
 * 実行
 *   POST   /v1/sessions/:id/messages           指示を送る。応答は SSE
 *
 * 認証（AUTH_MODE）
 *   iam   : Cloud Run の IAM 認証（呼び出し元 SA に run.invoker を付与）。アプリ側では検証しない
 *   token : Authorization: Bearer <API_TOKEN>
 *   none  : ローカル開発用
 * エンドユーザーの識別は、認証済みの呼び出し元が付ける x-user-id ヘッダーで行う。
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createStore, type Session } from "./store.js";
import { createSessionFiles, normalizeFilePath } from "./storage.js";
import { callRunner } from "./runner.js";

const store = createStore();
const files = createSessionFiles();
const app = express();

const AUTH_MODE = process.env.AUTH_MODE ?? "iam";
const API_TOKEN = process.env.API_TOKEN ?? "";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS ?? 100_000);
const MAX_UPLOAD_BYTES = process.env.MAX_UPLOAD_BYTES ?? "100mb";
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Firestore の 1 ドキュメント上限 (1MiB) に収めるための目安 */
const MAX_STORED_EVENTS_CHARS = 700_000;

const jsonSmall = express.json({ limit: "1mb" });
const jsonLarge = express.json({ limit: MAX_UPLOAD_BYTES });

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

/** Express 5 のワイルドカード (*path) は配列で入る */
function filePathParam(req: Request): string | null {
  const raw = (req.params as any).path;
  return normalizeFilePath(Array.isArray(raw) ? raw.join("/") : String(raw ?? ""));
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** data URL / base64 → Buffer */
function decodeData(data: string): Buffer {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(data);
  if (m) return m[1] ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]));
  return Buffer.from(data, "base64");
}

interface UploadItem {
  /** workspace 内の保存先。省略時は uploads/<filename> */
  path?: string;
  filename?: string;
  /** base64 または data URL */
  data: string;
  content_type?: string;
}

async function saveUploads(sessionId: string, items: UploadItem[]): Promise<string[]> {
  const saved: string[] = [];
  for (const it of items) {
    const name = it.path ?? (it.filename ? `uploads/${path.posix.basename(it.filename)}` : "");
    const p = normalizeFilePath(name);
    if (!p || typeof it.data !== "string") throw Object.assign(new Error(`invalid file: ${name}`), { status: 400 });
    await files.write(sessionId, p, decodeData(it.data), it.content_type);
    saved.push(p);
  }
  return saved;
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
    if (s) res.json({ session: s, turns: await store.listTurns(s.id) });
  }),
);

v1.delete(
  "/sessions/:id",
  wrap(async (req, res) => {
    const s = await ownSession(req, res);
    if (!s) return;
    if (store.isLocked(s)) {
      res.status(409).json({ error: "session is running" });
      return;
    }
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

/** 実行中はファイルを変更させない（Runner の書き戻しと衝突するため） */
async function ownIdleSession(req: Request, res: Response): Promise<Session | null> {
  const s = await ownSession(req, res);
  if (s && store.isLocked(s)) {
    res.status(409).json({ error: "session is running; try again after the turn finishes" });
    return null;
  }
  return s;
}

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

// ---------------------------------------------------------------- messages (SSE)

function compactEvents(events: any[]): any[] {
  const out = events.map((e) =>
    e.type === "tool_result" && e.content?.length > 2000 ? { ...e, content: e.content.slice(0, 2000) + "…" } : e,
  );
  // それでも大きすぎる場合は古いツール結果から中身を落とす
  let size = JSON.stringify(out).length;
  for (let i = 0; i < out.length && size > MAX_STORED_EVENTS_CHARS; i++) {
    if (out[i].type === "tool_result" || out[i].type === "tool_use") {
      const before = JSON.stringify(out[i]).length;
      out[i] = { type: out[i].type, id: out[i].id, toolUseId: out[i].toolUseId, name: out[i].name, omitted: true };
      size -= before - JSON.stringify(out[i]).length;
    }
  }
  return out;
}

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
    const model = ALLOWED_MODELS.includes(req.body?.model) ? String(req.body.model) : undefined;
    const effort = EFFORTS.includes(req.body?.effort) ? String(req.body.effort) : undefined;
    const systemPrompt = req.body?.system_prompt ? String(req.body.system_prompt).slice(0, 20_000) : undefined;

    if (!(await store.tryLock(s.id, TURN_TIMEOUT_MS + 5 * 60_000))) {
      res.status(409).json({ error: "this session is already running a turn" });
      return;
    }

    let attachments: string[] = [];
    try {
      attachments = await saveUploads(s.id, uploads);
    } catch (e) {
      await store.unlock(s.id, {});
      throw e;
    }
    const prompt = attachments.length
      ? `ユーザーが次のファイルを添付しました（作業ディレクトリからの相対パス）:\n${attachments
          .map((a) => `- ${a}`)
          .join("\n")}\n\n${input || "添付ファイルを確認してください。"}`
      : input;
    const turn = await store.startTurn(s.id, input, attachments);

    // ---- SSE
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    const sse = (ev: any) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    sse({ type: "session", session_id: s.id, turn_id: turn.id, attachments });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const events: any[] = [];
    const texts: string[] = [];
    let claudeSessionId = s.claudeSessionId;
    let cumulativeCost: number | undefined;
    let filesChanged: any;
    let error: string | undefined;
    let ok = false;

    try {
      const storage = await files.runnerStorageSpec(s.id);
      for await (const ev of callRunner(
        {
          sessionId: s.id,
          prompt,
          claudeSessionId: s.claudeSessionId,
          storage,
          options: { model, effort, systemPrompt },
        },
        abort.signal,
      )) {
        switch (ev.type) {
          case "heartbeat":
            res.write(": ping\n\n");
            continue;
          case "session":
            claudeSessionId = ev.claudeSessionId;
            continue; // 内部 ID は外に出さない
          case "text":
            texts.push(ev.text);
            break;
          case "result":
            cumulativeCost = Number(ev.costUsd ?? 0);
            ok = ev.ok;
            break;
          case "error":
            error = ev.message;
            break;
          case "files_changed": {
            const url = (p: string) => `/v1/sessions/${s.id}/files/${p.split("/").map(encodeURIComponent).join("/")}`;
            const withUrl = (xs: any[]) => xs.map((x) => ({ ...x, url: url(x.path) }));
            filesChanged = { added: withUrl(ev.added), modified: withUrl(ev.modified), deleted: ev.deleted };
            sse({ type: "files_changed", ...filesChanged });
            continue;
          }
        }
        if (ev.type !== "text_delta" && ev.type !== "status") events.push(ev);
        sse(ev);
      }
    } catch (err) {
      error = abort.signal.aborted ? "aborted or timed out" : (err as Error).message;
      console.error("turn error:", err);
      sse({ type: "error", message: error });
    } finally {
      clearTimeout(timer);
      // SDK の costUsd は resume したセッションの累計なので差分をそのターンのコストとする
      const prevTotal = s.totalCostUsd ?? 0;
      const total = cumulativeCost !== undefined ? Math.max(prevTotal, cumulativeCost) : prevTotal;
      await store
        .finishTurn(s.id, turn.id, {
          status: abort.signal.aborted ? "aborted" : ok && !error ? "completed" : "failed",
          text: texts.join("\n\n"),
          events: compactEvents(events),
          filesChanged,
          costUsd: total - prevTotal,
          error,
          finishedAt: Date.now(),
        })
        .catch((e) => console.error(e));
      await store
        .unlock(s.id, { claudeSessionId, totalCostUsd: total, incrementTurn: true })
        .catch((e) => console.error(e));
      sse({ type: "done", turn_id: turn.id });
      res.end();
    }
  }),
);

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
