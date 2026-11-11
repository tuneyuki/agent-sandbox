/**
 * セッションフォルダ (gs://BUCKET/sessions/{id}/) とコンテナ内 /sandbox の同期。
 *
 *   sessions/{id}/workspace/**          ⇔ /sandbox/workspace/**   （ファイル単位で同期）
 *   sessions/{id}/.state/claude.tar.gz  ⇔ /sandbox/claude/        （Claude Code の会話記録）
 *
 * ターン開始時に全部ダウンロードし、終了時に「追加・変更されたファイル」だけアップロード、
 * 「消されたファイル」は削除する。ユーザーがアップロードしたファイルも、エージェントが
 * 作ったファイルも、同じ workspace/ に並ぶ。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { md5File, type ObjectStore } from "./storage.js";

const run = promisify(execFile);

export const SANDBOX_ROOT = process.env.SANDBOX_ROOT ?? "/sandbox";
/** エージェントの作業ディレクトリ。resume のため固定パスにする。 */
export const WORKSPACE_DIR = path.join(SANDBOX_ROOT, "workspace");
/** CLAUDE_CONFIG_DIR。会話記録 (projects/*.jsonl) が入る。 */
export const CLAUDE_DIR = path.join(SANDBOX_ROOT, "claude");

const MAX_FILES = Number(process.env.MAX_WORKSPACE_FILES ?? 5000);
const MAX_TOTAL_BYTES = Number(process.env.MAX_WORKSPACE_BYTES ?? 1024 * 1024 * 1024);
/** 同期しないディレクトリ（再生成できる重いもの） */
const IGNORE_DIRS = new Set(
  (process.env.SYNC_IGNORE_DIRS ?? "node_modules,.venv,venv,__pycache__,.cache").split(","),
);
const PARALLEL = 8;

export interface FileChange {
  path: string; // workspace からの相対パス
  size?: number;
}
export interface SyncResult {
  added: FileChange[];
  modified: FileChange[];
  deleted: FileChange[];
}

/** workspace 相対パス → base64 md5 */
export type Manifest = Map<string, string>;

async function pool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

function safeJoin(root: string, rel: string): string {
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) throw new Error(`unsafe path: ${rel}`);
  return p;
}

export async function resetSandbox(): Promise<void> {
  await rm(WORKSPACE_DIR, { recursive: true, force: true });
  await rm(CLAUDE_DIR, { recursive: true, force: true });
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await mkdir(CLAUDE_DIR, { recursive: true });
}

/** セッションフォルダの内容を /sandbox に展開し、マニフェストを返す。 */
export async function restore(store: ObjectStore, sessionPrefix: string): Promise<Manifest> {
  const wsPrefix = `${sessionPrefix}workspace/`;
  const objects = await store.list(wsPrefix);
  const manifest: Manifest = new Map();

  await pool(objects, async (o) => {
    const rel = o.name.slice(wsPrefix.length);
    if (!rel || rel.endsWith("/")) return;
    await store.download(o.name, safeJoin(WORKSPACE_DIR, rel));
    manifest.set(rel, o.md5);
  });

  const tar = path.join(SANDBOX_ROOT, ".claude.tar.gz");
  if (await store.download(`${sessionPrefix}.state/claude.tar.gz`, tar)) {
    await run("tar", ["-xzf", tar, "-C", CLAUDE_DIR, "--no-same-owner"]);
    await rm(tar, { force: true });
  }
  return manifest;
}

/** /sandbox/workspace を走査（シンボリックリンクは追わない） */
async function scanWorkspace(): Promise<Map<string, { full: string; size: number }>> {
  const files = new Map<string, { full: string; size: number }>();
  let total = 0;
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const { size } = await lstat(full);
        total += size;
        if (files.size >= MAX_FILES) throw new Error(`too many files in workspace (> ${MAX_FILES})`);
        if (total > MAX_TOTAL_BYTES) throw new Error(`workspace too large (> ${MAX_TOTAL_BYTES} bytes)`);
        files.set(path.relative(WORKSPACE_DIR, full).split(path.sep).join("/"), { full, size });
      }
    }
  };
  await walk(WORKSPACE_DIR);
  return files;
}

/** 変更分をセッションフォルダに書き戻す。 */
export async function save(store: ObjectStore, sessionPrefix: string, manifest: Manifest): Promise<SyncResult> {
  const result: SyncResult = { added: [], modified: [], deleted: [] };
  const current = await scanWorkspace();

  const uploads: { rel: string; full: string; size: number; isNew: boolean }[] = [];
  for (const [rel, f] of current) {
    const before = manifest.get(rel);
    if (before === undefined) uploads.push({ rel, ...f, isNew: true });
    else if ((await md5File(f.full)) !== before) uploads.push({ rel, ...f, isNew: false });
  }
  await pool(uploads, async (u) => {
    await store.upload(`${sessionPrefix}workspace/${u.rel}`, u.full);
    (u.isNew ? result.added : result.modified).push({ path: u.rel, size: u.size });
  });

  const deletions = [...manifest.keys()].filter((rel) => !current.has(rel));
  await pool(deletions, async (rel) => {
    await store.delete(`${sessionPrefix}workspace/${rel}`);
    result.deleted.push({ path: rel });
  });

  const tar = path.join(SANDBOX_ROOT, ".claude.tar.gz");
  await run("tar", ["-czf", tar, "-C", CLAUDE_DIR, "."]);
  await store.upload(`${sessionPrefix}.state/claude.tar.gz`, tar, "application/gzip");
  await rm(tar, { force: true });

  return result;
}
