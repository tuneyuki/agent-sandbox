/**
 * Runner から見たオブジェクトストレージ。
 *
 * - gcs  : Gateway が発行した「このセッションのフォルダ (sessions/{id}/) だけ」に
 *          絞ったダウンスコープ済みアクセストークンで GCS JSON API を叩く。
 *          Runner の SA 自体にはバケット権限が無い。
 * - local: ローカル開発用。LOCAL_STORE_DIR 配下をバケットに見立てる。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ObjectInfo {
  /** バケット内のフルパス */
  name: string;
  size: number;
  /** base64 MD5（GCS の md5Hash と同じ形式） */
  md5: string;
}

export interface ObjectStore {
  list(prefix: string): Promise<ObjectInfo[]>;
  /** 無ければ false */
  download(name: string, dest: string): Promise<boolean>;
  upload(name: string, src: string, contentType?: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export type StorageSpec =
  | { type: "gcs"; bucket: string; accessToken: string }
  | { type: "local" };

export function createObjectStore(spec: StorageSpec): ObjectStore {
  return spec.type === "gcs" ? new GcsStore(spec.bucket, spec.accessToken) : new LocalStore();
}

export async function md5File(file: string): Promise<string> {
  const h = createHash("md5");
  await pipeline(createReadStream(file), h);
  return h.digest("base64");
}

// ------------------------------------------------------------------ GCS (JSON API)

const GCS = "https://storage.googleapis.com";

class GcsStore implements ObjectStore {
  constructor(
    private bucket: string,
    private token: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(`${GCS}/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
      u.searchParams.set("prefix", prefix);
      u.searchParams.set("fields", "items(name,size,md5Hash),nextPageToken");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const res = await fetch(u, { headers: this.headers() });
      if (!res.ok) throw new Error(`gcs list failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as any;
      for (const it of body.items ?? []) {
        out.push({ name: it.name, size: Number(it.size), md5: it.md5Hash ?? "" });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(name: string, dest: string): Promise<boolean> {
    const u = `${GCS}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?alt=media`;
    const res = await fetch(u, { headers: this.headers() });
    if (res.status === 404) return false;
    if (!res.ok || !res.body) throw new Error(`gcs download failed: ${res.status} ${name}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
    return true;
  }

  async upload(name: string, src: string, contentType = "application/octet-stream"): Promise<void> {
    const u = new URL(`${GCS}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    u.searchParams.set("uploadType", "media");
    u.searchParams.set("name", name);
    const { size } = await stat(src);
    const res = await fetch(u, {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "content-length": String(size) }),
      body: Readable.toWeb(createReadStream(src)) as any,
      // @ts-expect-error Node fetch のストリーム送信に必要
      duplex: "half",
    });
    if (!res.ok) throw new Error(`gcs upload failed: ${res.status} ${await res.text()}`);
  }

  async delete(name: string): Promise<void> {
    const u = `${GCS}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}`;
    const res = await fetch(u, { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`gcs delete failed: ${res.status}`);
  }
}

// ------------------------------------------------------------------ local

const LOCAL_ROOT = process.env.LOCAL_STORE_DIR ?? "/tmp/agent-sandbox-store";

function localPath(name: string): string {
  const p = path.resolve(LOCAL_ROOT, name);
  if (!p.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) throw new Error(`invalid object name: ${name}`);
  return p;
}

class LocalStore implements ObjectStore {
  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
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
          const name = path.relative(LOCAL_ROOT, full).split(path.sep).join("/");
          if (name.startsWith(prefix)) {
            out.push({ name, size: (await stat(full)).size, md5: await md5File(full) });
          }
        }
      }
    };
    await walk(LOCAL_ROOT);
    return out;
  }

  async download(name: string, dest: string): Promise<boolean> {
    try {
      await mkdir(path.dirname(dest), { recursive: true });
      await pipeline(createReadStream(localPath(name)), createWriteStream(dest));
      return true;
    } catch (e: any) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
  }

  async upload(name: string, src: string): Promise<void> {
    const dest = localPath(name);
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(createReadStream(src), createWriteStream(dest));
  }

  async delete(name: string): Promise<void> {
    await rm(localPath(name), { force: true });
  }
}
