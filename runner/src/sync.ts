/**
 * セッションフォルダ (gs://BUCKET/sessions/{id}/) とコンテナ内 /sandbox の同期。
 *
 *   sessions/{id}/workspace/**          ⇔ /sandbox/workspace/**   （ファイル単位で同期）
 *   sessions/{id}/.state/claude.tar.gz  ⇔ /sandbox/claude/        （Claude Code の会話記録）
 *   sessions/{id}/.state/deps.tar.*     ⇔ node_modules/ や .venv/ （依存キャッシュ。1 アーカイブ）
 *
 * node_modules や .venv はファイル数が多いのでファイル単位では同期せず、まとめて 1 つの
 * アーカイブにする。中身が変わったとき（指紋が変わったとき）だけアップロードし直す。
 *
 * ターン開始時に全部ダウンロードし、終了時に「追加・変更されたファイル」だけアップロード、
 * 「消されたファイル」は削除する。ユーザーがアップロードしたファイルも、エージェントが
 * 作ったファイルも、同じ workspace/ に並ぶ。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
/** ファイル単位では同期せず、依存キャッシュとしてまとめて保存するディレクトリ */
const DEPS_DIRS = new Set((process.env.DEPS_DIRS ?? "node_modules,.venv,venv").split(","));
/** まったく保存しないディレクトリ（再生成が安いもの） */
const SKIP_DIRS = new Set((process.env.SKIP_DIRS ?? "__pycache__,.cache,.pytest_cache,.next/cache").split(","));
const MAX_DEPS_BYTES = Number(process.env.MAX_DEPS_BYTES ?? 2 * 1024 * 1024 * 1024);
const PARALLEL = 8;

export interface FileChange {
  path: string; // workspace からの相対パス
  size?: number;
}
export interface SyncResult {
  added: FileChange[];
  modified: FileChange[];
  deleted: FileChange[];
  /** 依存キャッシュの状態 */
  deps?: "unchanged" | "saved" | "removed" | "too_large";
}

/** 復元時の状態（workspace 相対パス → base64 md5、依存キャッシュの指紋） */
export interface Manifest {
  files: Map<string, string>;
  depsFingerprint: string | null;
}

// ------------------------------------------------------------------ 依存キャッシュの圧縮形式

let zstdAvailable: boolean | null = null;
async function archiveExt(): Promise<"tar.zst" | "tar.gz"> {
  if (zstdAvailable === null) {
    zstdAvailable = await run("zstd", ["--version"]).then(
      () => true,
      () => false,
    );
  }
  return zstdAvailable ? "tar.zst" : "tar.gz";
}
const tarCompressFlag = (ext: string) => (ext === "tar.zst" ? "--zstd" : "-z");

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
  const manifest: Manifest = { files: new Map(), depsFingerprint: null };

  await pool(objects, async (o) => {
    const rel = o.name.slice(wsPrefix.length);
    if (!rel || rel.endsWith("/")) return;
    await store.download(o.name, safeJoin(WORKSPACE_DIR, rel));
    manifest.files.set(rel, o.md5);
  });

  manifest.depsFingerprint = await restoreDeps(store, sessionPrefix);

  const tar = path.join(SANDBOX_ROOT, ".claude.tar.gz");
  if (await store.download(`${sessionPrefix}.state/claude.tar.gz`, tar)) {
    await run("tar", ["-xzf", tar, "-C", CLAUDE_DIR, "--no-same-owner"]);
    await rm(tar, { force: true });
  }
  return manifest;
}

/** /sandbox/workspace を走査（シンボリックリンクは追わない）。依存ディレクトリは別に返す */
async function scanWorkspace(): Promise<{
  files: Map<string, { full: string; size: number }>;
  depsDirs: string[];
}> {
  const files = new Map<string, { full: string; size: number }>();
  const depsDirs: string[] = [];
  let total = 0;
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(WORKSPACE_DIR, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (DEPS_DIRS.has(e.name)) depsDirs.push(rel);
        else if (!SKIP_DIRS.has(e.name) && !SKIP_DIRS.has(rel)) await walk(full);
      } else if (e.isFile()) {
        const { size } = await lstat(full);
        total += size;
        if (files.size >= MAX_FILES) throw new Error(`too many files in workspace (> ${MAX_FILES})`);
        if (total > MAX_TOTAL_BYTES) throw new Error(`workspace too large (> ${MAX_TOTAL_BYTES} bytes)`);
        files.set(rel, { full, size });
      }
    }
  };
  await walk(WORKSPACE_DIR);
  return { files, depsDirs: depsDirs.sort() };
}

/**
 * 依存ディレクトリの指紋。深さ 4 までのエントリ名・サイズ・mtime から作る
 * （node_modules/<pkg>、.venv/lib/pythonX/site-packages/<pkg> まで届く）。
 * tar 展開は mtime を保つので、何もインストールしなければ指紋は変わらない。
 */
async function depsFingerprint(depsDirs: string[]): Promise<string | null> {
  if (!depsDirs.length) return null;
  const h = createHash("sha256");
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const st = await lstat(full);
      h.update(`${path.relative(WORKSPACE_DIR, full)}|${st.size}|${Math.floor(st.mtimeMs)}\n`);
      if (e.isDirectory() && depth < 4) await walk(full, depth + 1);
    }
  };
  for (const d of depsDirs) {
    h.update(`#${d}\n`);
    await walk(path.join(WORKSPACE_DIR, d), 1);
  }
  return h.digest("hex");
}

async function restoreDeps(store: ObjectStore, sessionPrefix: string): Promise<string | null> {
  const fpFile = path.join(SANDBOX_ROOT, ".deps.fp");
  if (!(await store.download(`${sessionPrefix}.state/deps.fingerprint`, fpFile))) return null;
  const [ext, fp] = (await readFile(fpFile, "utf8")).trim().split(" ");
  await rm(fpFile, { force: true });
  const archive = path.join(SANDBOX_ROOT, `.deps.${ext}`);
  if (!(await store.download(`${sessionPrefix}.state/deps.${ext}`, archive))) return null;
  await run("tar", ["-x", tarCompressFlag(ext), "-f", archive, "-C", WORKSPACE_DIR, "--no-same-owner"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  await rm(archive, { force: true });
  // 展開後に指紋を取り直す（保存時と同じ値になるはず）
  const { depsDirs } = await scanWorkspace();
  return (await depsFingerprint(depsDirs)) ?? fp;
}

async function saveDeps(
  store: ObjectStore,
  sessionPrefix: string,
  depsDirs: string[],
  before: string | null,
): Promise<SyncResult["deps"]> {
  const fp = await depsFingerprint(depsDirs);
  if (fp === before) return "unchanged";
  const ext = await archiveExt();
  if (!fp) {
    await store.delete(`${sessionPrefix}.state/deps.fingerprint`);
    await store.delete(`${sessionPrefix}.state/deps.tar.zst`);
    await store.delete(`${sessionPrefix}.state/deps.tar.gz`);
    return "removed";
  }
  const list = path.join(SANDBOX_ROOT, ".deps.list");
  const archive = path.join(SANDBOX_ROOT, `.deps.${ext}`);
  await writeFile(list, depsDirs.join("\n") + "\n");
  await run("tar", ["-c", tarCompressFlag(ext), "-f", archive, "-C", WORKSPACE_DIR, "-T", list]);
  await rm(list, { force: true });
  const { size } = await stat(archive);
  if (size > MAX_DEPS_BYTES) {
    await rm(archive, { force: true });
    return "too_large";
  }
  await store.upload(`${sessionPrefix}.state/deps.${ext}`, archive, "application/octet-stream");
  await rm(archive, { force: true });
  const fpFile = path.join(SANDBOX_ROOT, ".deps.fp");
  await writeFile(fpFile, `${ext} ${fp}\n`);
  await store.upload(`${sessionPrefix}.state/deps.fingerprint`, fpFile, "text/plain");
  await rm(fpFile, { force: true });
  return "saved";
}

/** 変更分をセッションフォルダに書き戻す。 */
export async function save(store: ObjectStore, sessionPrefix: string, manifest: Manifest): Promise<SyncResult> {
  const result: SyncResult = { added: [], modified: [], deleted: [] };
  const { files: current, depsDirs } = await scanWorkspace();

  const uploads: { rel: string; full: string; size: number; isNew: boolean }[] = [];
  for (const [rel, f] of current) {
    const before = manifest.files.get(rel);
    if (before === undefined) uploads.push({ rel, ...f, isNew: true });
    else if ((await md5File(f.full)) !== before) uploads.push({ rel, ...f, isNew: false });
  }
  await pool(uploads, async (u) => {
    await store.upload(`${sessionPrefix}workspace/${u.rel}`, u.full);
    (u.isNew ? result.added : result.modified).push({ path: u.rel, size: u.size });
  });

  const deletions = [...manifest.files.keys()].filter((rel) => !current.has(rel));
  await pool(deletions, async (rel) => {
    await store.delete(`${sessionPrefix}workspace/${rel}`);
    result.deleted.push({ path: rel });
  });

  result.deps = await saveDeps(store, sessionPrefix, depsDirs, manifest.depsFingerprint);

  const tar = path.join(SANDBOX_ROOT, ".claude.tar.gz");
  await run("tar", ["-czf", tar, "-C", CLAUDE_DIR, "."]);
  await store.upload(`${sessionPrefix}.state/claude.tar.gz`, tar, "application/gzip");
  await rm(tar, { force: true });

  return result;
}
