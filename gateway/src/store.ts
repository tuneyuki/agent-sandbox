/**
 * セッションとチャット履歴の保存先。
 * 本番は Firestore、ローカル開発はメモリ（STORE=memory）。
 */
import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";

export interface Session {
  id: string;
  owner: string;
  title: string;
  claudeSessionId?: string;
  createdAt: number;
  updatedAt: number;
  /** 実行中ロックの期限 (epoch ms)。0 なら空き。 */
  lockedUntil: number;
  totalCostUsd: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** assistant の場合はイベント列（text / tool_use / tool_result / result / error）も保存 */
  text: string;
  events?: unknown[];
  createdAt: number;
}

export interface Store {
  createSession(owner: string, title: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(owner: string): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
  /** ロックを取得できたら true。同一セッションでの同時実行を防ぐ。 */
  tryLock(id: string, ttlMs: number): Promise<boolean>;
  unlock(id: string, patch: { claudeSessionId?: string; addCostUsd?: number }): Promise<void>;
  addMessage(sessionId: string, msg: Omit<ChatMessage, "id" | "createdAt">): Promise<ChatMessage>;
  listMessages(sessionId: string): Promise<ChatMessage[]>;
}

export function newSessionId(): string {
  return randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------- memory

export class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, ChatMessage[]>();

  async createSession(owner: string, title: string) {
    const now = Date.now();
    const s: Session = {
      id: newSessionId(),
      owner,
      title,
      createdAt: now,
      updatedAt: now,
      lockedUntil: 0,
      totalCostUsd: 0,
    };
    this.sessions.set(s.id, s);
    this.messages.set(s.id, []);
    return { ...s };
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async listSessions(owner: string) {
    return [...this.sessions.values()]
      .filter((s) => s.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
    this.messages.delete(id);
  }
  async tryLock(id: string, ttlMs: number) {
    const s = this.sessions.get(id);
    if (!s) return false;
    const now = Date.now();
    if (s.lockedUntil > now) return false;
    s.lockedUntil = now + ttlMs;
    return true;
  }
  async unlock(id: string, patch: { claudeSessionId?: string; addCostUsd?: number }) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lockedUntil = 0;
    s.updatedAt = Date.now();
    if (patch.claudeSessionId) s.claudeSessionId = patch.claudeSessionId;
    if (patch.addCostUsd) s.totalCostUsd += patch.addCostUsd;
  }
  async addMessage(sessionId: string, msg: Omit<ChatMessage, "id" | "createdAt">) {
    const m: ChatMessage = { ...msg, id: randomUUID(), createdAt: Date.now() };
    this.messages.get(sessionId)?.push(m);
    return m;
  }
  async listMessages(sessionId: string) {
    return [...(this.messages.get(sessionId) ?? [])];
  }
}

// ---------------------------------------------------------------- firestore

export class FirestoreStore implements Store {
  private db: Firestore;
  constructor(databaseId?: string) {
    this.db = new Firestore({ databaseId, ignoreUndefinedProperties: true });
  }
  private col() {
    return this.db.collection("sessions");
  }

  async createSession(owner: string, title: string) {
    const now = Date.now();
    const s: Session = {
      id: newSessionId(),
      owner,
      title,
      createdAt: now,
      updatedAt: now,
      lockedUntil: 0,
      totalCostUsd: 0,
    };
    await this.col().doc(s.id).set(s);
    return s;
  }
  async getSession(id: string) {
    const snap = await this.col().doc(id).get();
    return snap.exists ? (snap.data() as Session) : null;
  }
  async listSessions(owner: string) {
    const q = await this.col().where("owner", "==", owner).orderBy("updatedAt", "desc").limit(100).get();
    return q.docs.map((d) => d.data() as Session);
  }
  async deleteSession(id: string) {
    await this.db.recursiveDelete(this.col().doc(id));
  }
  async tryLock(id: string, ttlMs: number) {
    const ref = this.col().doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const s = snap.data() as Session;
      const now = Date.now();
      if (s.lockedUntil > now) return false;
      tx.update(ref, { lockedUntil: now + ttlMs });
      return true;
    });
  }
  async unlock(id: string, patch: { claudeSessionId?: string; addCostUsd?: number }) {
    await this.col()
      .doc(id)
      .update({
        lockedUntil: 0,
        updatedAt: Date.now(),
        claudeSessionId: patch.claudeSessionId,
        totalCostUsd: FieldValue.increment(patch.addCostUsd ?? 0),
      });
  }
  async addMessage(sessionId: string, msg: Omit<ChatMessage, "id" | "createdAt">) {
    const ref = this.col().doc(sessionId).collection("messages").doc();
    const m: ChatMessage = { ...msg, id: ref.id, createdAt: Date.now() };
    await ref.set({ ...m, ts: Timestamp.now() });
    return m;
  }
  async listMessages(sessionId: string) {
    const q = await this.col().doc(sessionId).collection("messages").orderBy("createdAt").get();
    return q.docs.map((d) => {
      const { ts: _ts, ...rest } = d.data();
      return rest as ChatMessage;
    });
  }
}

export function createStore(): Store {
  return process.env.STORE === "memory"
    ? new MemoryStore()
    : new FirestoreStore(process.env.FIRESTORE_DATABASE || undefined);
}
