/**
 * セッションフォルダ（1 バケットの中を sessions/{id}/ で論理分割）へのアクセス。
 *
 *   gs://BUCKET/sessions/{sessionId}/workspace/**          ← ユーザーのファイル + エージェントの成果物
 *   gs://BUCKET/sessions/{sessionId}/workspace/uploads/**  ← API / チャットで渡されたファイルの置き場
 *   gs://BUCKET/sessions/{sessionId}/.state/claude.tar.gz  ← Claude Code の会話記録（内部用）
 *
 * Runner に渡すトークンは Credential Access Boundary で sessions/{id}/ 配下だけに絞る。
 */
import { Storage } from "@google-cloud/storage";
import { DownscopedClient, GoogleAuth } from "google-auth-library";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BUCKET = process.env.STATE_BUCKET;
const LOCAL_ROOT = process.env.LOCAL_STORE_DIR ?? "/tmp/agent-sandbox-store";

export const sessionPrefix = (sessionId: string) => `sessions/${sessionId}/`;
export const workspacePrefix = (sessionId: string) => `${sessionPrefix(sessionId)}workspace/`;

/** ユーザー指定のファイルパスを検証・正規化する（workspace 相対）。 */
export function normalizeFilePath(p: string): string | null {
  const norm = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!norm || norm === "." || norm.startsWith("..") || norm.includes("/../") || norm.endsWith("/")) return null;
  if (norm.length > 512 || /[\x00-\x1f]/.test(norm)) return null;
  return norm;
}

export interface FileInfo {
  path: string;
  size: number;
  updated: string;
  contentType?: string;
}

export interface SessionFiles {
  list(sessionId: string): Promise<FileInfo[]>;
  read(sessionId: string, file: string): Promise<{ stream: Readable; size: number; contentType?: string } | null>;
  write(sessionId: string, file: string, body: Readable | Buffer, contentType?: string): Promise<void>;
  remove(sessionId: string, file: string): Promise<boolean>;
  removeSession(sessionId: string): Promise<void>;
  /** Runner に渡すストレージ指定 */
  runnerStorageSpec(sessionId: string): Promise<{ type: "gcs"; bucket: string; accessToken: string } | { type: "local" }>;
}

// ------------------------------------------------------------------ GCS

class GcsFiles implements SessionFiles {
  private storage = new Storage();
  private auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  constructor(private bucket: string) {}

  private file(sessionId: string, p: string) {
    return this.storage.bucket(this.bucket).file(workspacePrefix(sessionId) + p);
  }

  async list(sessionId: string): Promise<FileInfo[]> {
    const prefix = workspacePrefix(sessionId);
    const [files] = await this.storage.bucket(this.bucket).getFiles({ prefix, autoPaginate: true });
    return files.map((f) => ({
      path: f.name.slice(prefix.length),
      size: Number(f.metadata.size ?? 0),
      updated: String(f.metadata.updated ?? ""),
      contentType: f.metadata.contentType,
    }));
  }

  async read(sessionId: string, p: string) {
    const f = this.file(sessionId, p);
    const [exists] = await f.exists();
    if (!exists) return null;
    const [meta] = await f.getMetadata();
    return { stream: f.createReadStream(), size: Number(meta.size ?? 0), contentType: meta.contentType };
  }

  async write(sessionId: string, p: string, body: Readable | Buffer, contentType?: string) {
    const f = this.file(sessionId, p);
    if (Buffer.isBuffer(body)) await f.save(body, { contentType, resumable: false });
    else await pipeline(body, f.createWriteStream({ contentType, resumable: false }));
  }

  async remove(sessionId: string, p: string) {
    const [res] = await this.file(sessionId, p).delete({ ignoreNotFound: true });
    return (res as any)?.statusCode !== 404;
  }

  async removeSession(sessionId: string) {
    await this.storage.bucket(this.bucket).deleteFiles({ prefix: sessionPrefix(sessionId), force: true });
  }

  async runnerStorageSpec(sessionId: string) {
    const prefix = sessionPrefix(sessionId);
    const client = new DownscopedClient({
      authClient: (await this.auth.getClient()) as any,
      credentialAccessBoundary: {
        accessBoundary: {
          accessBoundaryRules: [
            {
              availableResource: `//storage.googleapis.com/projects/_/buckets/${this.bucket}`,
              availablePermissions: ["inRole:roles/storage.objectAdmin"],
              availabilityCondition: {
                title: `session-${sessionId}`,
                // オブジェクト操作は sessions/{id}/ 配下のみ、一覧も同 prefix 指定時のみ許可
                expression:
                  `resource.name.startsWith('projects/_/buckets/${this.bucket}/objects/${prefix}') || ` +
                  `api.getAttribute('storage.googleapis.com/objectListPrefix', '').startsWith('${prefix}')`,
              },
            },
          ],
        },
      },
    });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("failed to mint downscoped token");
    return { type: "gcs" as const, bucket: this.bucket, accessToken: token };
  }
}

// ------------------------------------------------------------------ local (開発用)

class LocalFiles implements SessionFiles {
  private abs(sessionId: string, p = ""): string {
    const root = path.resolve(LOCAL_ROOT, workspacePrefix(sessionId));
    const full = path.resolve(root, p);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error("invalid path");
    return full;
  }

  async list(sessionId: string): Promise<FileInfo[]> {
    const root = this.abs(sessionId);
    const out: FileInfo[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const s = await stat(full);
          out.push({
            path: path.relative(root, full).split(path.sep).join("/"),
            size: s.size,
            updated: s.mtime.toISOString(),
          });
        }
      }
    };
    await walk(root);
    return out;
  }

  async read(sessionId: string, p: string) {
    try {
      const full = this.abs(sessionId, p);
      const s = await stat(full);
      if (!s.isFile()) return null;
      return { stream: createReadStream(full) as Readable, size: s.size };
    } catch {
      return null;
    }
  }

  async write(sessionId: string, p: string, body: Readable | Buffer) {
    const full = this.abs(sessionId, p);
    await mkdir(path.dirname(full), { recursive: true });
    const ws = createWriteStream(full);
    if (Buffer.isBuffer(body)) await new Promise<void>((r, j) => ws.end(body, () => r()).on("error", j));
    else await pipeline(body, ws);
  }

  async remove(sessionId: string, p: string) {
    const full = this.abs(sessionId, p);
    try {
      await stat(full);
    } catch {
      return false;
    }
    await rm(full, { force: true });
    return true;
  }

  async removeSession(sessionId: string) {
    await rm(path.resolve(LOCAL_ROOT, sessionPrefix(sessionId)), { recursive: true, force: true });
  }

  async runnerStorageSpec() {
    return { type: "local" as const };
  }
}

export function createSessionFiles(): SessionFiles {
  return BUCKET ? new GcsFiles(BUCKET) : new LocalFiles();
}
