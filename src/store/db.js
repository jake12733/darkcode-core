// 통합 저장소 (Node 내장 SQLite): 세션 · 메시지 · 스냅샷 · 실행 기록 · 실행 로그 · 응답 캐시
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, snapshot TEXT, created INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, meta TEXT, created INTEGER);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT, input TEXT, category TEXT, pipeline TEXT, status TEXT, route TEXT, result TEXT, ms INTEGER, created INTEGER);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER, level TEXT, msg TEXT);
      CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id, id);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT, title TEXT, file TEXT, meta TEXT, created INTEGER);
    `);
    this.q = {
      insSession: this.db.prepare('INSERT INTO sessions (id, title, snapshot, created, updated) VALUES (?, ?, NULL, ?, ?)'),
      getSession: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
      listSessions: this.db.prepare('SELECT id, title, updated FROM sessions ORDER BY updated DESC LIMIT ?'),
      touchSession: this.db.prepare('UPDATE sessions SET updated = ?, title = COALESCE(title, ?) WHERE id = ?'),
      setSnapshot: this.db.prepare('UPDATE sessions SET snapshot = ?, updated = ? WHERE id = ?'),
      delSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      delMessages: this.db.prepare('DELETE FROM messages WHERE session_id = ?'),
      insMessage: this.db.prepare('INSERT INTO messages (session_id, role, content, meta, created) VALUES (?, ?, ?, ?, ?)'),
      messages: this.db.prepare('SELECT role, content, meta, created FROM messages WHERE session_id = ? ORDER BY id'),
      insRun: this.db.prepare('INSERT INTO runs (id, session_id, input, category, pipeline, status, route, result, ms, created) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)'),
      updRun: this.db.prepare('UPDATE runs SET category = ?, pipeline = ?, status = ?, route = ?, result = ?, ms = ? WHERE id = ?'),
      getRun: this.db.prepare('SELECT * FROM runs WHERE id = ?'),
      runsBySession: this.db.prepare('SELECT id, input, category, pipeline, status, ms, created FROM runs WHERE session_id = ? ORDER BY created DESC LIMIT 50'),
      insLog: this.db.prepare('INSERT INTO logs (run_id, ts, level, msg) VALUES (?, ?, ?, ?)'),
      logs: this.db.prepare('SELECT ts, level, msg FROM logs WHERE run_id = ? ORDER BY id'),
      cacheGet: this.db.prepare('SELECT value, expires FROM cache WHERE key = ?'),
      cachePut: this.db.prepare('INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)'),
      cachePurge: this.db.prepare('DELETE FROM cache WHERE expires < ?'),
      insMedia: this.db.prepare('INSERT OR REPLACE INTO media (id, kind, title, file, meta, created) VALUES (?, ?, ?, ?, ?, ?)'),
      listMedia: this.db.prepare('SELECT * FROM media ORDER BY created DESC LIMIT ?'),
      getMediaByFile: this.db.prepare('SELECT * FROM media WHERE file = ?'),
      delMedia: this.db.prepare('DELETE FROM media WHERE id = ?'),
    };
  }

  ensureSession(id, title) {
    const now = Date.now();
    if (id && this.q.getSession.get(id)) { this.q.touchSession.run(now, title, id); return id; }
    const sid = id || randomUUID();
    this.q.insSession.run(sid, title?.slice(0, 60) || null, now, now);
    return sid;
  }
  session(id) {
    const s = this.q.getSession.get(id);
    if (!s) return null;
    return { ...s, snapshot: s.snapshot ? JSON.parse(s.snapshot) : null, messages: this.q.messages.all(id).map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })), runs: this.q.runsBySession.all(id) };
  }
  sessions(limit = 50) { return this.q.listSessions.all(limit); }
  deleteSession(id) { this.q.delMessages.run(id); this.q.delSession.run(id); }
  messages(id) { return this.q.messages.all(id).map((m) => ({ role: m.role, content: m.content, meta: m.meta ? JSON.parse(m.meta) : null })); }
  addMessage(sid, role, content, meta) { this.q.insMessage.run(sid, role, content, meta ? JSON.stringify(meta) : null, Date.now()); }
  setSnapshot(sid, snap) { this.q.setSnapshot.run(JSON.stringify(snap), Date.now(), sid); }

  startRun(sid, input) { const id = randomUUID(); this.q.insRun.run(id, sid, input, 'running', Date.now()); return id; }
  finishRun(id, { category, pipeline, status, route, result, ms }) { this.q.updRun.run(category || null, pipeline || null, status, JSON.stringify(route || []), result ? JSON.stringify(result) : null, ms || 0, id); }
  run(id) { const r = this.q.getRun.get(id); return r && { ...r, route: JSON.parse(r.route || '[]'), result: r.result ? JSON.parse(r.result) : null, logs: this.q.logs.all(id) }; }
  log(runId, level, msg) { this.q.insLog.run(runId, Date.now(), level, msg); }

  addMedia(m) { const { id, kind, title, file, created, ...rest } = m; this.q.insMedia.run(id, kind, title, file, JSON.stringify(rest), created || Date.now()); }
  media(limit = 100) { return this.q.listMedia.all(limit).map((r) => ({ id: r.id, kind: r.kind, title: r.title, file: r.file, url: `/dc/media/${r.file}`, created: r.created, ...JSON.parse(r.meta || '{}') })); }
  mediaByFile(file) { return this.q.getMediaByFile.get(file) || null; }
  deleteMedia(id) { this.q.delMedia.run(id); }

  static key(obj) { return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 24); }
  cacheGet(key) { const r = this.q.cacheGet.get(key); if (!r || r.expires < Date.now()) return null; return JSON.parse(r.value); }
  cachePut(key, value, ttlSec) { this.q.cachePut.run(key, JSON.stringify(value), Date.now() + ttlSec * 1000); }
  purge() { this.q.cachePurge.run(Date.now()); }
}
