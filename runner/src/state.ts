/**
 * セッション状態（作業ディレクトリ + Claude Code のトランスクリプト）の復元・保存。
 *
 * Runner は 1 コンテナ = 1 ターン同時実行（Cloud Run concurrency=1）で動き、
 * ターンごとに /sandbox をまっさらにしてから状態を復元する。
 *
 * - 本番: Gateway が発行した GCS 署名付き URL で tar.gz を GET / PUT する。
 *   Runner のサービスアカウントにはバケット権限を一切付けないので、
 *   エージェントがメタデータサーバーからトークンを取っても他セッションの状態は読めない。
 * - ローカル開発: 署名付き URL が無ければ LOCAL_STATE_DIR に保存する。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

export const SANDBOX_ROOT = process.env.SANDBOX_ROOT ?? "/sandbox";
/** エージェントの作業ディレクトリ。resume 時にパスが一致する必要があるため固定。 */
export const WORKSPACE_DIR = path.join(SANDBOX_ROOT, "workspace");
/** CLAUDE_CONFIG_DIR。セッションのトランスクリプト (projects/*.jsonl) がここに入る。 */
export const CLAUDE_DIR = path.join(SANDBOX_ROOT, "claude");

const LOCAL_STATE_DIR = process.env.LOCAL_STATE_DIR ?? "/tmp/agent-sandbox-state";
const MAX_STATE_BYTES = Number(process.env.MAX_STATE_BYTES ?? 200 * 1024 * 1024);

export interface StateLocation {
  sessionId: string;
  downloadUrl?: string;
  uploadUrl?: string;
}

export async function resetSandbox(): Promise<void> {
  await rm(WORKSPACE_DIR, { recursive: true, force: true });
  await rm(CLAUDE_DIR, { recursive: true, force: true });
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await mkdir(CLAUDE_DIR, { recursive: true });
}

function archivePath(): string {
  return path.join(SANDBOX_ROOT, ".state.tar.gz");
}

function localArchive(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("invalid sessionId");
  return path.join(LOCAL_STATE_DIR, `${sessionId}.tar.gz`);
}

/** 状態を復元する。存在しなければ（新規セッション）何もしない。 */
export async function restoreState(loc: StateLocation): Promise<boolean> {
  const archive = archivePath();
  let data: Buffer | null = null;

  if (loc.downloadUrl) {
    const res = await fetch(loc.downloadUrl);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`state download failed: ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  } else {
    try {
      data = await readFile(localArchive(loc.sessionId));
    } catch {
      return false;
    }
  }

  await writeFile(archive, data);
  // -C で /sandbox 配下に展開。tar は絶対パスや .. を既定で除去する。
  await run("tar", ["-xzf", archive, "-C", SANDBOX_ROOT, "--no-same-owner"]);
  await rm(archive, { force: true });
  return true;
}

/** 状態を保存する。 */
export async function saveState(loc: StateLocation): Promise<void> {
  const archive = archivePath();
  await run("tar", ["-czf", archive, "-C", SANDBOX_ROOT, "workspace", "claude"]);
  const { size } = await stat(archive);
  if (size > MAX_STATE_BYTES) {
    await rm(archive, { force: true });
    throw new Error(`state too large: ${size} bytes (limit ${MAX_STATE_BYTES})`);
  }
  const data = await readFile(archive);
  await rm(archive, { force: true });

  if (loc.uploadUrl) {
    const res = await fetch(loc.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body: data,
    });
    if (!res.ok) throw new Error(`state upload failed: ${res.status} ${await res.text()}`);
  } else {
    await mkdir(LOCAL_STATE_DIR, { recursive: true });
    await writeFile(localArchive(loc.sessionId), data);
  }
}
