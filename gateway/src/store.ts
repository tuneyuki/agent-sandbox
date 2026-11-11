/**
 * セッションとターンのメタデータ（Firestore）。ファイルの実体は GCS 側。
 *
 *   sessions/{sessionId}
 *     owner, title, claudeSessionId, status, lockedUntil, turnCount, totalCostUsd, createdAt, updatedAt
 *   sessions/{sessionId}/turns/{turnId}
 *     input, attachments[], status, text, events[], filesChanged, costUsd, error, startedAt, finishedAt
 *
 * 本番は Firestore、ローカル開発はメモリ（STORE=memory）。
 */
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";

export type SessionStatus = "idle" | "running";

export interface Session {
  id: string;
  owner: string;
  title: string;
  claudeSessionId?: string;
  status: SessionStatus;
  /** 実行中ロックの期限 (epoch ms)。Gateway が落ちてもこの時刻を過ぎれば解放扱い */
  lockedUntil: number;
  turnCount: number;
  /** SDK が返す累計コストの推定値 */
  totalCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export type TurnStatus = "running" | "completed" | "failed" | "aborted";

export interface Turn {
  id: string;
  input: string;
  attachments: string[];
  status: TurnStatus;
  /** アシスタントの最終テキスト */
  text: string;
  /** 表示用イベント列（text_delta は除外、tool_result は切り詰め） */
  events: unknown[];
  filesChanged?: { added: unknown[]; modified: unknown[]; deleted: unknown[] };
  costUsd?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface Store {
  createSession(owner: string, title: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(owner: string): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
  /** ロック取得に成功したら true（同一セッションの同時実行・実行中のファイル変更を防ぐ） */
  tryLock(id: string, ttlMs: number): Promise<boolean>;
  unlock(id: string, patch: { claudeSessionId?: string; totalCostUsd?: number; incrementTurn?: boolean }): Promise<void>;
  isLocked(s: Session): boolean;
  startTurn(sessionId: string, input: string, attachments: string[]): Promise<Turn>;
  finishTurn(sessionId: string, turnId: string, patch: Partial<Turn>): Promise<void>;
  listTurns(sessionId: string): Promise<Turn[]>;
}

function newId(): string {
  return randomUUID().replace(/-/g, "");
}

function newSession(owner: string, title: string): Session {
  const now = Date.now();
  return {
    id: newId(),
    owner,
    title,
    status: "idle",
    lockedUntil: 0,
    turnCount: 0,
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const isLocked = (s: Session) => s.status === "running" && s.lockedUntil > Date.now();

// ---------------------------------------------------------------- memory

export class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private turns = new Map<string, Turn[]>();
  isLocked = isLocked;

  async createSession(owner: string, title: string) {
    const s = newSession(owner, title);
    this.sessions.set(s.id, s);
    this.turns.set(s.id, []);
    return { ...s };
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async listSessions(owner: string) {
    return [...this.sessions.values()].filter((s) => s.owner === owner).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
    this.turns.delete(id);
  }
  async tryLock(id: string, ttlMs: number) {
    const s = this.sessions.get(id);
    if (!s || isLocked(s)) return false;
    s.status = "running";
    s.lockedUntil = Date.now() + ttlMs;
    return true;
  }
  async unlock(id: string, patch: { claudeSessionId?: string; totalCostUsd?: number; incrementTurn?: boolean }) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = "idle";
    s.lockedUntil = 0;
    s.updatedAt = Date.now();
    if (patch.claudeSessionId) s.claudeSessionId = patch.claudeSessionId;
    if (patch.totalCostUsd !== undefined) s.totalCostUsd = patch.totalCostUsd;
    if (patch.incrementTurn) s.turnCount++;
  }
  async startTurn(sessionId: string, input: string, attachments: string[]) {
    const t: Turn = { id: newId(), input, attachments, status: "running", text: "", events: [], startedAt: Date.now() };
    this.turns.get(sessionId)?.push(t);
    return { ...t };
  }
  async finishTurn(sessionId: string, turnId: string, patch: Partial<Turn>) {
    const t = this.turns.get(sessionId)?.find((x) => x.id === turnId);
    if (t) Object.assign(t, patch);
  }
  async listTurns(sessionId: string) {
    return [...(this.turns.get(sessionId) ?? [])];
  }
}

// ---------------------------------------------------------------- firestore

export class FirestoreStore implements Store {
  private db: Firestore;
  isLocked = isLocked;
  constructor(databaseId?: string) {
    this.db = new Firestore({ databaseId, ignoreUndefinedProperties: true });
  }
  private col() {
    return this.db.collection("sessions");
  }

  async createSession(owner: string, title: string) {
    const s = newSession(owner, title);
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
      if (!snap.exists || isLocked(snap.data() as Session)) return false;
      tx.update(ref, { status: "running", lockedUntil: Date.now() + ttlMs });
      return true;
    });
  }
  async unlock(id: string, patch: { claudeSessionId?: string; totalCostUsd?: number; incrementTurn?: boolean }) {
    await this.col()
      .doc(id)
      .update({
        status: "idle",
        lockedUntil: 0,
        updatedAt: Date.now(),
        claudeSessionId: patch.claudeSessionId,
        totalCostUsd: patch.totalCostUsd,
        turnCount: patch.incrementTurn ? FieldValue.increment(1) : undefined,
      });
  }
  async startTurn(sessionId: string, input: string, attachments: string[]) {
    const ref = this.col().doc(sessionId).collection("turns").doc();
    const t: Turn = { id: ref.id, input, attachments, status: "running", text: "", events: [], startedAt: Date.now() };
    await ref.set(t);
    return t;
  }
  async finishTurn(sessionId: string, turnId: string, patch: Partial<Turn>) {
    await this.col().doc(sessionId).collection("turns").doc(turnId).update(patch);
  }
  async listTurns(sessionId: string) {
    const q = await this.col().doc(sessionId).collection("turns").orderBy("startedAt").get();
    return q.docs.map((d) => d.data() as Turn);
  }
}

export function createStore(): Store {
  return process.env.STORE === "memory"
    ? new MemoryStore()
    : new FirestoreStore(process.env.FIRESTORE_DATABASE || undefined);
}
