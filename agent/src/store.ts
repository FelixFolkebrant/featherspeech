import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentId } from "./profiles.js";

export type RecordKind = "message" | "memory" | "task";
export type StoredRecord = { id: number; conversation: string; agent: AgentId; kind: RecordKind; payload: string; text: string; created: number };

export function messageText(m: AgentMessage): string {
  if (m.role === "playback_note" || m.role === "room_note") return m.text;
  if (typeof m.content === "string") return m.content;
  return m.content.map(c => c.type === "text" ? c.text : "").join("\n");
}

/** One owner-only SQLite room, no extra DB service or embeddings dependency. */
export class RoomStore {
  readonly db: DatabaseSync;
  revision = 0;
  private conversationRevision = -1;
  private conversationCache: { id: string; title: string; created: number; updated: number; count: number }[] = [];
  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, conversation TEXT NOT NULL,
        agent TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_conversation ON records(conversation,kind,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(text, content='records', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS records_insert AFTER INSERT ON records BEGIN
        INSERT INTO records_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS records_update AFTER UPDATE ON records BEGIN
        INSERT INTO records_fts(records_fts,rowid,text) VALUES('delete',old.id,old.text);
        INSERT INTO records_fts(rowid,text) VALUES(new.id,new.text); END;`);
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown) { this.db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
  add(conversation: string, agent: AgentId, kind: RecordKind, payload: unknown, text: string): number {
    this.revision++;
    return Number(this.db.prepare("INSERT INTO records(conversation,agent,kind,payload,text,created) VALUES(?,?,?,?,?,?)").run(conversation, agent, kind, JSON.stringify(payload), text, Date.now()).lastInsertRowid);
  }
  update(id: number, payload: unknown, text: string) { this.revision++; this.db.prepare("UPDATE records SET payload=?,text=? WHERE id=?").run(JSON.stringify(payload), text, id); }
  appendMessages(conversation: string, agent: AgentId, messages: AgentMessage[]) {
    this.db.exec("BEGIN");
    try {
      for (const message of messages) if (message.role !== "system") this.add(conversation, agent, "message", message, messageText(message));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  messages(conversation: string, maxTurns: number): { id: number; agent: AgentId; message: AgentMessage }[] {
    // Bound the database read before decoding large transcripts.
    const rows = this.db.prepare("SELECT id,agent,payload FROM records WHERE conversation=? AND kind='message' ORDER BY id DESC LIMIT ?").all(conversation, maxTurns * 32 + 32) as { id: number; agent: AgentId; payload: string }[];
    return rows.reverse().map(r => ({ id: r.id, agent: r.agent, message: JSON.parse(r.payload) }));
  }
  allTasks<T>(): T[] { return (this.db.prepare("SELECT payload FROM records WHERE kind='task' ORDER BY id").all() as { payload: string }[]).map(r => JSON.parse(r.payload) as T); }
  conversations(): { id: string; title: string; created: number; updated: number; count: number }[] {
    if (this.conversationRevision === this.revision) return this.conversationCache;
    this.conversationCache = this.db.prepare(`SELECT r.conversation AS id, MIN(r.created) AS created, MAX(r.created) AS updated,
      COUNT(*) AS count, COALESCE((SELECT substr(first.text,1,100) FROM records first
        WHERE first.conversation=r.conversation AND first.kind='message'
        AND json_extract(first.payload,'$.role')='user' ORDER BY first.id LIMIT 1), 'Conversation') AS title
      FROM records r WHERE r.kind='message' GROUP BY r.conversation ORDER BY updated DESC LIMIT 100`)
      .all() as { id: string; title: string; created: number; updated: number; count: number }[];
    this.conversationRevision = this.revision;
    return this.conversationCache;
  }
  search(query: string, agent?: AgentId, kind?: RecordKind, limit = 6): StoredRecord[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!words.length) return [];
    const match = words.map(w => `"${w}"`).join(" OR ");
    return this.db.prepare(`SELECT r.* FROM records_fts JOIN records r ON r.id=records_fts.rowid
      WHERE records_fts MATCH ? AND (? IS NULL OR r.agent=?) AND (? IS NULL OR r.kind=?)
      ORDER BY rank, r.id DESC LIMIT ?`).all(match, agent ?? null, agent ?? null, kind ?? null, kind ?? null, Math.max(1, Math.min(20, limit))) as StoredRecord[];
  }
  close() { this.db.close(); }
}
