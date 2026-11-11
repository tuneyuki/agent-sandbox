/**
 * セッション・ターン・イベント（Firestore）。ファイルの実体は GCS 側。
 *
 *   sessions/{sessionId}
 *     owner, title, status (idle|running), activeTurnId, lockedUntil,
 *     claudeSessionId, turnCount, totalCostUsd, createdAt, updatedAt
 *   sessions/{sessionId}/turns/{turnId}
 *     input, attachments, prompt, options, status, text, filesChanged, costUsd, error,
 *     tokenHash, cancelRequested, lastSeq, startedAt, finishedAt
 *   sessions/{sessionId}/turns/{turnId}/events/{seq}
 *     seq, type, json（イベント本体を JSON 文字列で）
 *
 * 実行中ロック: Runner が生存報告するたびに lockedUntil を延ばす。報告が途絶えて期限を
 * 過ぎたら（Runner の異常終了など）、そのターンは失敗扱いにしてロックを解放する。
 *
 * 本番は Firestore、ローカル開発はメモリ（STORE=memory）。
 */
import { Firestore, FieldValue, type Transaction } from "@google-cloud/firestore";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface Session {
  id: string;
  owner: string;
  title: string;
  status: "idle" | "running";
  activeTurnId: string | null;
  lockedUntil: number;
  claudeSessionId?: string;
  turnCount: number;
  totalCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export const TERMINAL: TurnStatus[] = ["completed", "failed", "aborted"];

export interface Turn {
  id: string;
  sessionId: string;
  input: string;
  attachments: string[];
  /** Runner に渡す実際のプロンプト（添付の案内を含む） */
  prompt: string;
  options: { model?: string; effort?: string; systemPrompt?: string };
  status: TurnStatus;
  text: string;
  filesChanged?: unknown;
  costUsd?: number;
  error?: string;
  tokenHash: string;
  cancelRequested: boolean;
  /** 最後のイベントの seq（終了時に確定） */
  lastSeq?: number;
  startedAt: number;
  finishedAt?: number;
}

export interface StoredEvent {
  seq: number;
  [k: string]: unknown;
}

export interface FinishInput {
  status: Exclude<TurnStatus, "queued" | "running">;
  text?: string;
  filesChanged?: unknown;
  error?: string;
  /** SDK のセッション累計コスト（あれば） */
  cumulativeCostUsd?: number;
  claudeSessionId?: string;
  /** Runner が送った最後のイベントの seq */
  lastSeq: number;
}

export interface Store {
  createSession(owner: string, title: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(owner: string): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;

  /** 実行中のセッション数（同時実行数の上限チェック用。厳密ではない） */
  countRunning(): Promise<number>;
  /** ロックを取ってターンを作る。実行中なら null */
  beginTurn(
    sessionId: string,
    init: Pick<Turn, "input" | "attachments" | "prompt" | "options" | "tokenHash">,
    lockMs: number,
  ): Promise<Turn | null>;
  getTurn(sessionId: string, turnId: string): Promise<Turn | null>;
  listTurns(sessionId: string): Promise<Turn[]>;
  markRunning(sessionId: string, turnId: string): Promise<void>;
  /** 生存報告。ロックを延長し、中断要求の有無を返す */
  heartbeat(sessionId: string, turnId: string, lockMs: number): Promise<{ active: boolean; cancel: boolean }>;
  requestCancel(sessionId: string, turnId: string): Promise<void>;
  /** ターンを終了させ、done イベントを書き、ロックを外す。既に終了済みなら false */
  finishTurn(sessionId: string, turnId: string, f: FinishInput): Promise<boolean>;
  /** 生存報告が途絶えたターンを失敗にする */
  reapStale(sessionId: string): Promise<void>;

  appendEvents(sessionId: string, turnId: string, events: StoredEvent[]): Promise<void>;
  listEvents(sessionId: string, turnId: string, afterSeq: number): Promise<StoredEvent[]>;
  /** afterSeq より後のイベントを順に通知する。戻り値で購読解除 */
  watchEvents(sessionId: string, turnId: string, afterSeq: number, cb: (evs: StoredEvent[]) => void): () => void;
}

const newId = () => randomUUID().replace(/-/g, "");
const isLocked = (s: Session) => s.status === "running" && s.lockedUntil > Date.now();
const isStale = (s: Session) => s.status === "running" && s.lockedUntil <= Date.now();

function newSession(owner: string, title: string): Session {
  const now = Date.now();
  return {
    id: newId(),
    owner,
    title,
    status: "idle",
    activeTurnId: null,
    lockedUntil: 0,
    turnCount: 0,
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function newTurn(sessionId: string, init: Pick<Turn, "input" | "attachments" | "prompt" | "options" | "tokenHash">): Turn {
  return {
    id: newId(),
    sessionId,
    ...init,
    status: "queued",
    text: "",
    cancelRequested: false,
    startedAt: Date.now(),
  };
}

/** 終了処理で書く値を計算する（Firestore / メモリ共通） */
function finishPatch(s: Session, t: Turn, f: FinishInput) {
  const prevTotal = s.totalCostUsd ?? 0;
  const total = f.cumulativeCostUsd !== undefined ? Math.max(prevTotal, f.cumulativeCostUsd) : prevTotal;
  const doneSeq = f.lastSeq + 1;
  const turn: Partial<Turn> = {
    status: f.status,
    text: f.text ?? t.text,
    filesChanged: f.filesChanged,
    error: f.error,
    costUsd: total - prevTotal,
    lastSeq: doneSeq,
    finishedAt: Date.now(),
  };
  const done: StoredEvent = {
    seq: doneSeq,
    type: "done",
    turn_id: t.id,
    status: f.status,
    error: f.error,
    cost_usd: total - prevTotal,
  };
  const session: Partial<Session> | null =
    s.activeTurnId === t.id
      ? {
          status: "idle",
          activeTurnId: null,
          lockedUntil: 0,
          updatedAt: Date.now(),
          claudeSessionId: f.claudeSessionId ?? s.claudeSessionId,
          totalCostUsd: total,
        }
      : null;
  return { turn, done, session };
}

const STALE_ERROR = "runner stopped responding";

// ---------------------------------------------------------------- memory

export class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private turns = new Map<string, Turn>(); // key: turnId
  private events = new Map<string, StoredEvent[]>(); // key: turnId
  private bus = new EventEmitter().setMaxListeners(0);

  async createSession(owner: string, title: string) {
    const s = newSession(owner, title);
    this.sessions.set(s.id, s);
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
    for (const [tid, t] of this.turns) if (t.sessionId === id) (this.turns.delete(tid), this.events.delete(tid));
  }
  async countRunning() {
    return [...this.sessions.values()].filter(isLocked).length;
  }
  async beginTurn(sessionId: string, init: any, lockMs: number) {
    await this.reapStale(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s || isLocked(s)) return null;
    const t = newTurn(sessionId, init);
    this.turns.set(t.id, t);
    this.events.set(t.id, []);
    Object.assign(s, { status: "running", activeTurnId: t.id, lockedUntil: Date.now() + lockMs, turnCount: s.turnCount + 1 });
    return { ...t };
  }
  async getTurn(sessionId: string, turnId: string) {
    const t = this.turns.get(turnId);
    return t && t.sessionId === sessionId ? { ...t } : null;
  }
  async listTurns(sessionId: string) {
    return [...this.turns.values()].filter((t) => t.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt);
  }
  async markRunning(_sid: string, turnId: string) {
    const t = this.turns.get(turnId);
    if (t && t.status === "queued") t.status = "running";
  }
  async heartbeat(sessionId: string, turnId: string, lockMs: number) {
    const s = this.sessions.get(sessionId);
    const t = this.turns.get(turnId);
    const active = !!s && !!t && s.activeTurnId === turnId && !TERMINAL.includes(t.status);
    if (active) {
      s!.lockedUntil = Date.now() + lockMs;
      if (t!.status === "queued") t!.status = "running";
    }
    return { active, cancel: !!t?.cancelRequested };
  }
  async requestCancel(_sid: string, turnId: string) {
    const t = this.turns.get(turnId);
    if (t) t.cancelRequested = true;
  }
  async finishTurn(sessionId: string, turnId: string, f: FinishInput) {
    const s = this.sessions.get(sessionId);
    const t = this.turns.get(turnId);
    if (!s || !t || TERMINAL.includes(t.status)) return false;
    const p = finishPatch(s, t, f);
    Object.assign(t, p.turn);
    if (p.session) Object.assign(s, p.session);
    await this.appendEvents(sessionId, turnId, [p.done]);
    return true;
  }
  async reapStale(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s && isStale(s) && s.activeTurnId) {
      const t = this.turns.get(s.activeTurnId);
      const evs = this.events.get(s.activeTurnId) ?? [];
      await this.finishTurn(sessionId, s.activeTurnId, {
        status: "failed",
        error: STALE_ERROR,
        lastSeq: evs.length ? evs[evs.length - 1].seq : 0,
        text: t?.text,
      });
    }
  }
  async appendEvents(_sid: string, turnId: string, events: StoredEvent[]) {
    const list = this.events.get(turnId);
    if (!list) return;
    const added: StoredEvent[] = [];
    for (const e of events) {
      const i = list.findIndex((x) => x.seq === e.seq);
      if (i >= 0) list[i] = e;
      else (list.push(e), added.push(e));
    }
    list.sort((a, b) => a.seq - b.seq);
    if (added.length) this.bus.emit(turnId, added);
  }
  async listEvents(_sid: string, turnId: string, afterSeq: number) {
    return (this.events.get(turnId) ?? []).filter((e) => e.seq > afterSeq);
  }
  watchEvents(sessionId: string, turnId: string, afterSeq: number, cb: (evs: StoredEvent[]) => void) {
    let last = afterSeq;
    const deliver = (evs: StoredEvent[]) => {
      const fresh = evs.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
      if (fresh.length) {
        last = fresh[fresh.length - 1].seq;
        cb(fresh);
      }
    };
    this.bus.on(turnId, deliver);
    this.listEvents(sessionId, turnId, afterSeq).then(deliver);
    return () => this.bus.off(turnId, deliver);
  }
}

// ---------------------------------------------------------------- firestore

const MAX_EVENT_JSON = 200_000;

/** Firestore の 1 ドキュメント上限 (1MiB) に収まるよう大きなイベントを切り詰める */
function encodeEvent(e: StoredEvent): { seq: number; type: string; json: string } {
  let json = JSON.stringify(e);
  if (json.length > MAX_EVENT_JSON) {
    const { seq, type } = e;
    json = JSON.stringify({ seq, type, id: e.id, name: e.name, toolUseId: e.toolUseId, truncated: true, preview: json.slice(0, 10_000) });
  }
  return { seq: e.seq, type: String(e.type ?? ""), json };
}

export class FirestoreStore implements Store {
  private db: Firestore;
  constructor(databaseId?: string) {
    this.db = new Firestore({ databaseId, ignoreUndefinedProperties: true });
  }
  private sessions() {
    return this.db.collection("sessions");
  }
  private turnsCol(sid: string) {
    return this.sessions().doc(sid).collection("turns");
  }
  private eventsCol(sid: string, tid: string) {
    return this.turnsCol(sid).doc(tid).collection("events");
  }
  private eventRef(sid: string, tid: string, seq: number) {
    return this.eventsCol(sid, tid).doc(String(seq).padStart(10, "0"));
  }

  async createSession(owner: string, title: string) {
    const s = newSession(owner, title);
    await this.sessions().doc(s.id).set(s);
    return s;
  }
  async getSession(id: string) {
    const snap = await this.sessions().doc(id).get();
    return snap.exists ? (snap.data() as Session) : null;
  }
  async listSessions(owner: string) {
    const q = await this.sessions().where("owner", "==", owner).orderBy("updatedAt", "desc").limit(100).get();
    return q.docs.map((d) => d.data() as Session);
  }
  async deleteSession(id: string) {
    await this.db.recursiveDelete(this.sessions().doc(id));
  }

  async countRunning() {
    const q = await this.sessions().where("status", "==", "running").where("lockedUntil", ">", Date.now()).count().get();
    return q.data().count;
  }
  async beginTurn(sessionId: string, init: any, lockMs: number) {
    await this.reapStale(sessionId);
    const sref = this.sessions().doc(sessionId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(sref);
      if (!snap.exists || isLocked(snap.data() as Session)) return null;
      const t = newTurn(sessionId, init);
      tx.set(this.turnsCol(sessionId).doc(t.id), t);
      tx.update(sref, {
        status: "running",
        activeTurnId: t.id,
        lockedUntil: Date.now() + lockMs,
        turnCount: FieldValue.increment(1),
      });
      return t;
    });
  }
  async getTurn(sessionId: string, turnId: string) {
    const snap = await this.turnsCol(sessionId).doc(turnId).get();
    return snap.exists ? (snap.data() as Turn) : null;
  }
  async listTurns(sessionId: string) {
    const q = await this.turnsCol(sessionId).orderBy("startedAt").get();
    return q.docs.map((d) => d.data() as Turn);
  }
  async markRunning(sessionId: string, turnId: string) {
    await this.turnsCol(sessionId).doc(turnId).update({ status: "running" });
  }
  async heartbeat(sessionId: string, turnId: string, lockMs: number) {
    const sref = this.sessions().doc(sessionId);
    const tref = this.turnsCol(sessionId).doc(turnId);
    return this.db.runTransaction(async (tx) => {
      const [s, t] = await Promise.all([tx.get(sref), tx.get(tref)]);
      const sd = s.data() as Session | undefined;
      const td = t.data() as Turn | undefined;
      const active = !!sd && !!td && sd.activeTurnId === turnId && !TERMINAL.includes(td.status);
      if (active) {
        tx.update(sref, { lockedUntil: Date.now() + lockMs });
        if (td!.status === "queued") tx.update(tref, { status: "running" });
      }
      return { active, cancel: !!td?.cancelRequested };
    });
  }
  async requestCancel(sessionId: string, turnId: string) {
    await this.turnsCol(sessionId).doc(turnId).update({ cancelRequested: true });
  }
  private async finishInTx(tx: Transaction, sessionId: string, turnId: string, f: FinishInput) {
    const sref = this.sessions().doc(sessionId);
    const tref = this.turnsCol(sessionId).doc(turnId);
    const [s, t] = await Promise.all([tx.get(sref), tx.get(tref)]);
    if (!s.exists || !t.exists) return false;
    const td = t.data() as Turn;
    if (TERMINAL.includes(td.status)) return false;
    const p = finishPatch(s.data() as Session, td, f);
    tx.update(tref, p.turn);
    tx.set(this.eventRef(sessionId, turnId, p.done.seq), encodeEvent(p.done));
    if (p.session) tx.update(sref, p.session);
    return true;
  }
  async finishTurn(sessionId: string, turnId: string, f: FinishInput) {
    return this.db.runTransaction((tx) => this.finishInTx(tx, sessionId, turnId, f));
  }
  async reapStale(sessionId: string) {
    const s = await this.getSession(sessionId);
    if (!s || !isStale(s) || !s.activeTurnId) return;
    const turnId = s.activeTurnId;
    const last = await this.eventsCol(sessionId, turnId).orderBy("seq", "desc").limit(1).get();
    const lastSeq = last.empty ? 0 : (last.docs[0].data().seq as number);
    await this.db.runTransaction(async (tx) => {
      const fresh = (await tx.get(this.sessions().doc(sessionId))).data() as Session | undefined;
      if (!fresh || !isStale(fresh) || fresh.activeTurnId !== turnId) return;
      await this.finishInTx(tx, sessionId, turnId, { status: "failed", error: STALE_ERROR, lastSeq });
    });
  }

  async appendEvents(sessionId: string, turnId: string, events: StoredEvent[]) {
    for (let i = 0; i < events.length; i += 400) {
      const batch = this.db.batch();
      for (const e of events.slice(i, i + 400)) batch.set(this.eventRef(sessionId, turnId, e.seq), encodeEvent(e));
      await batch.commit();
    }
  }
  async listEvents(sessionId: string, turnId: string, afterSeq: number) {
    const q = await this.eventsCol(sessionId, turnId).where("seq", ">", afterSeq).orderBy("seq").get();
    return q.docs.map((d) => JSON.parse(d.data().json) as StoredEvent);
  }
  watchEvents(sessionId: string, turnId: string, afterSeq: number, cb: (evs: StoredEvent[]) => void) {
    let last = afterSeq;
    return this.eventsCol(sessionId, turnId)
      .where("seq", ">", afterSeq)
      .orderBy("seq")
      .onSnapshot(
        (snap) => {
          const fresh = snap
            .docChanges()
            .filter((c) => c.type !== "removed")
            .map((c) => JSON.parse(c.doc.data().json) as StoredEvent)
            .filter((e) => e.seq > last)
            .sort((a, b) => a.seq - b.seq);
          if (fresh.length) {
            last = fresh[fresh.length - 1].seq;
            cb(fresh);
          }
        },
        (err) => console.error("watchEvents error:", err),
      );
  }
}

export function createStore(): Store {
  return process.env.STORE === "memory"
    ? new MemoryStore()
    : new FirestoreStore(process.env.FIRESTORE_DATABASE || undefined);
}
