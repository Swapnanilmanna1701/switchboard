'use strict';
// SQLite store. ADR-5: node:sqlite + WAL + FTS5, zero runtime dependencies.
// Every public method is fail-open (Principle 7 / ADR-8): a broken store must
// never be the reason a session fails to start.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  link_key    TEXT,              -- cwd|ppid, reconciles MCP and hook views
  pid         INTEGER,
  agent_pid   INTEGER,
  name        TEXT,
  agent       TEXT,              -- claude-code | cursor | gemini-cli | codex | ...
  agent_ver   TEXT,
  tier        INTEGER DEFAULT 1, -- 1 = MCP only, 3 = hook-enhanced
  cwd         TEXT,
  workspace   TEXT,
  started_at  INTEGER,
  last_seen   INTEGER,
  status      TEXT,              -- active | idle | ended
  intent      TEXT,
  synthetic   INTEGER DEFAULT 0  -- 1 = pid-derived id, may be merged into a real one
);
CREATE INDEX IF NOT EXISTS idx_sessions_ws   ON sessions(workspace, status);
CREATE INDEX IF NOT EXISTS idx_sessions_link ON sessions(link_key);

CREATE TABLE IF NOT EXISTS claims (
  path        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  workspace   TEXT,
  claimed_at  INTEGER,
  expires_at  INTEGER,
  op          TEXT,              -- edit | write | reserve
  observed    INTEGER DEFAULT 1, -- 1 = hook-observed (T3), 0 = self-declared (T1)
  reason      TEXT,
  PRIMARY KEY (path, session_id)
);
CREATE INDEX IF NOT EXISTS idx_claims_ws ON claims(workspace, expires_at);

CREATE TABLE IF NOT EXISTS digests (
  session_id  TEXT PRIMARY KEY,
  workspace   TEXT,
  updated_at  INTEGER,
  intent      TEXT,
  files       TEXT,              -- JSON array
  commands    TEXT,              -- JSON array
  last_msg    TEXT,
  tokens      INTEGER
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  workspace   TEXT,
  created_at  INTEGER,
  text        TEXT,
  tags        TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_ws ON notes(workspace, created_at);

-- A queued "attach to this session" request, consumed by the NEXT session that
-- starts in this workspace. One-shot and TTL'd, so a forgotten request never
-- silently hijacks a session you started hours later.
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace   TEXT,
  target_id   TEXT,          -- session being attached to
  target_name TEXT,
  requested_at INTEGER,
  expires_at  INTEGER,
  adopt       INTEGER DEFAULT 0,  -- also take over the target's file claims
  consumed_by TEXT,               -- session id that used it (null = pending)
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attach_ws ON attachments(workspace, consumed_by, expires_at);

CREATE TABLE IF NOT EXISTS events (
  ts          INTEGER,
  session_id  TEXT,
  workspace   TEXT,
  kind        TEXT,              -- inject | warn | pull | collision | reap | note
  tokens      INTEGER DEFAULT 0,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ws ON events(workspace, ts);
`;

// FTS5 is optional. §10.8 relies on it for sb_search; without it we degrade to
// LIKE, which is slower but correct. Never fail the store over search.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

class Store {
  constructor(dbPath) {
    this.path = dbPath;
    this.db = null;
    this.fts = false;
    this.ok = false;
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=50');   // ADR-5: give up fast, never hang a hook
      this.db.exec('PRAGMA synchronous=NORMAL');
      this.db.exec(SCHEMA);
      try { this.db.exec(FTS_SCHEMA); this.fts = true; } catch { this.fts = false; }
      this.db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)')
        .run('schema_version', String(SCHEMA_VERSION));
      try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
      this.ok = true;
    } catch (e) {
      this.ok = false;
      this.error = e;
    }
  }

  _run(sql, ...args) {
    if (!this.ok) return null;
    try { return this.db.prepare(sql).run(...args); } catch { return null; }
  }
  _all(sql, ...args) {
    if (!this.ok) return [];
    try { return this.db.prepare(sql).all(...args); } catch { return []; }
  }
  _get(sql, ...args) {
    if (!this.ok) return null;
    try { return this.db.prepare(sql).get(...args) ?? null; } catch { return null; }
  }

  // ---- sessions -----------------------------------------------------------

  upsertSession(s) {
    const now = Date.now();
    const prev = this._get('SELECT * FROM sessions WHERE session_id = ?', s.session_id);
    // Keep the richer value when two writers (MCP server + hook) describe the
    // same session. Hooks know the name and intent; MCP knows the client.
    const merged = {
      session_id: s.session_id,
      link_key:   s.link_key   ?? prev?.link_key   ?? null,
      pid:        s.pid        ?? prev?.pid        ?? null,
      agent_pid:  s.agent_pid  ?? prev?.agent_pid  ?? null,
      name:       s.name       ?? prev?.name       ?? null,
      agent:      s.agent      ?? prev?.agent      ?? null,
      agent_ver:  s.agent_ver  ?? prev?.agent_ver  ?? null,
      tier:       Math.max(s.tier ?? 1, prev?.tier ?? 1),
      cwd:        s.cwd        ?? prev?.cwd        ?? null,
      workspace:  s.workspace  ?? prev?.workspace  ?? null,
      started_at: prev?.started_at ?? s.started_at ?? now,
      last_seen:  now,
      status:     s.status     ?? prev?.status     ?? 'active',
      intent:     s.intent     ?? prev?.intent     ?? null,
      // Once a session is known by a real id it never reverts to synthetic.
      synthetic:  prev?.synthetic === 0 ? 0
                : s.synthetic === undefined ? (prev?.synthetic ?? 0)
                : (s.synthetic ? 1 : 0),
    };
    this._run(
      `INSERT INTO sessions
         (session_id,link_key,pid,agent_pid,name,agent,agent_ver,tier,cwd,workspace,started_at,last_seen,status,intent,synthetic)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         link_key=excluded.link_key, pid=excluded.pid, agent_pid=excluded.agent_pid,
         name=excluded.name, agent=excluded.agent, agent_ver=excluded.agent_ver,
         tier=excluded.tier, cwd=excluded.cwd, workspace=excluded.workspace,
         last_seen=excluded.last_seen, status=excluded.status, intent=excluded.intent,
         synthetic=excluded.synthetic`,
      merged.session_id, merged.link_key, merged.pid, merged.agent_pid, merged.name,
      merged.agent, merged.agent_ver, merged.tier, merged.cwd, merged.workspace,
      merged.started_at, merged.last_seen, merged.status, merged.intent, merged.synthetic
    );
    return merged;
  }

  touch(sessionId, status) {
    this._run('UPDATE sessions SET last_seen=?, status=COALESCE(?,status) WHERE session_id=?',
      Date.now(), status ?? null, sessionId);
  }

  endSession(sessionId) {
    this._run("UPDATE sessions SET status='ended', last_seen=? WHERE session_id=?", Date.now(), sessionId);
    this._run('DELETE FROM claims WHERE session_id=?', sessionId);
  }

  getSession(sessionId) {
    return this._get('SELECT * FROM sessions WHERE session_id=?', sessionId);
  }

  // FR-2.1 / FR-2.2: live peers in this workspace, excluding self.
  // Liveness is (status != ended) AND heartbeat within ttl AND pid alive.
  livePeers(workspace, selfId, ttlMs) {
    const cutoff = Date.now() - ttlMs;
    const rows = this._all(
      `SELECT * FROM sessions
        WHERE workspace = ? AND session_id != COALESCE(?, '') AND status != 'ended'
          AND last_seen >= ?
        ORDER BY last_seen DESC`,
      workspace, selfId ?? '', cutoff
    );
    const alive = rows.filter(r => isPidAlive(r.agent_pid ?? r.pid));

    // §11.7 — the MCP server and the hooks can each register the SAME agent
    // session: the server only knows the agent's pid, the hooks know its real
    // session id. Collapse those two views into one row.
    //
    // Only a *synthetic* (pid-derived) row is ever absorbed into a real one,
    // and only by a row for the SAME agent — the two views of one session
    // always agree on the agent. Two real sessions that share a parent process
    // stay distinct: collapsing them would silently hide a peer, which is far
    // worse than showing a duplicate.
    const mergeKey = r => `${r.agent || '?'}|${r.link_key}`;
    const realKeys = new Set(alive.filter(r => !r.synthetic && r.link_key).map(mergeKey));
    return alive.filter(r => !(r.synthetic && r.link_key && realKeys.has(mergeKey(r))));
  }

  // FR-2.4: reap sessions whose process is gone or whose heartbeat lapsed,
  // and release their claims. A dead session's claim must never block (FR-2.5).
  reap(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    const rows = this._all("SELECT session_id, agent_pid, pid, last_seen FROM sessions WHERE status != 'ended'");
    let reaped = 0;
    for (const r of rows) {
      const dead = !isPidAlive(r.agent_pid ?? r.pid) || r.last_seen < cutoff;
      if (dead) { this.endSession(r.session_id); reaped++; }
    }
    this._run('DELETE FROM claims WHERE expires_at < ?', Date.now());
    return reaped;
  }

  // ---- claims -------------------------------------------------------------

  addClaim({ path: p, session_id, workspace, ttlMs, op = 'edit', observed = 1, reason = null }) {
    const now = Date.now();
    this._run(
      `INSERT INTO claims(path,session_id,workspace,claimed_at,expires_at,op,observed,reason)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(path,session_id) DO UPDATE SET
         claimed_at=excluded.claimed_at, expires_at=excluded.expires_at,
         op=excluded.op, observed=MAX(claims.observed, excluded.observed),
         reason=COALESCE(excluded.reason, claims.reason)`,
      p, session_id, workspace, now, now + ttlMs, op, observed ? 1 : 0, reason
    );
  }

  // FR-4.2 / FR-4.6: foreign live claims only — a session never warns on itself.
  foreignClaims(workspace, p, selfId) {
    return this._all(
      `SELECT c.*, s.name, s.agent, s.intent, s.status
         FROM claims c LEFT JOIN sessions s ON s.session_id = c.session_id
        WHERE c.workspace = ? AND c.path = ? AND c.session_id != COALESCE(?, '')
          AND c.expires_at > ?
        ORDER BY c.claimed_at DESC`,
      workspace, p, selfId ?? '', Date.now()
    ).filter(c => isPidAliveForSession(this, c.session_id));
  }

  claimsFor(sessionId) {
    return this._all('SELECT * FROM claims WHERE session_id=? AND expires_at > ? ORDER BY claimed_at DESC',
      sessionId, Date.now());
  }

  releaseClaims(sessionId) { this._run('DELETE FROM claims WHERE session_id=?', sessionId); }

  // ---- digests ------------------------------------------------------------

  putDigest(d) {
    this._run(
      `INSERT INTO digests(session_id,workspace,updated_at,intent,files,commands,last_msg,tokens)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace=excluded.workspace, updated_at=excluded.updated_at, intent=excluded.intent,
         files=excluded.files, commands=excluded.commands, last_msg=excluded.last_msg,
         tokens=excluded.tokens`,
      d.session_id, d.workspace, Date.now(), d.intent ?? null,
      JSON.stringify(d.files ?? []), JSON.stringify(d.commands ?? []),
      d.last_msg ?? null, d.tokens ?? 0
    );
  }

  getDigest(sessionId) {
    const d = this._get('SELECT * FROM digests WHERE session_id=?', sessionId);
    if (!d) return null;
    return { ...d, files: safeParse(d.files, []), commands: safeParse(d.commands, []) };
  }

  // ---- notes --------------------------------------------------------------

  addNote({ session_id, workspace, text, tags }) {
    const r = this._run('INSERT INTO notes(session_id,workspace,created_at,text,tags) VALUES(?,?,?,?,?)',
      session_id, workspace, Date.now(), text, tags ?? null);
    return r ? Number(r.lastInsertRowid) : null;
  }

  // FR-5.3. FTS5 when available, LIKE otherwise — same shape either way.
  searchNotes(workspace, query, limit = 20) {
    if (this.fts) {
      const rows = this._all(
        `SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
          WHERE f.notes_fts MATCH ? AND n.workspace = ?
          ORDER BY n.created_at DESC LIMIT ?`,
        ftsEscape(query), workspace, limit);
      if (rows.length) return rows;
    }
    return this._all(
      `SELECT * FROM notes WHERE workspace = ? AND text LIKE ?
        ORDER BY created_at DESC LIMIT ?`,
      workspace, `%${query}%`, limit);
  }

  recentNotes(workspace, limit = 10) {
    return this._all('SELECT * FROM notes WHERE workspace=? ORDER BY created_at DESC LIMIT ?',
      workspace, limit);
  }

  // FR-5.3, full form. The injected roster tells the model that sb_search finds
  // "prior work", so it must cover everything the commons knows — not only
  // explicitly posted notes but also what sessions have actually been doing.
  // Searching notes alone made a session's headline finding unfindable.
  search(workspace, query, limit = 20) {
    const q = String(query || '').trim();
    if (!q) return [];
    const notes = this.searchNotes(workspace, q, limit)
      .map(r => ({ kind: 'note', session_id: r.session_id, ts: r.created_at, text: r.text, tags: r.tags }));

    const like = `%${q}%`;
    const digests = this._all(
      `SELECT d.session_id, d.updated_at, d.intent, d.last_msg, d.files
         FROM digests d
        WHERE d.workspace = ?
          AND (d.last_msg LIKE ? OR d.intent LIKE ? OR d.files LIKE ?)
        ORDER BY d.updated_at DESC LIMIT ?`,
      workspace, like, like, like, limit
    ).map(r => ({
      kind: 'activity', session_id: r.session_id, ts: r.updated_at,
      text: r.last_msg || r.intent || '', tags: null,
    })).filter(r => r.text);

    const seen = new Set();
    return [...notes, ...digests]
      .filter(r => { const k = `${r.session_id}|${r.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  // ---- attach ------------------------------------------------------------

  // Sessions worth attaching to: live ones first, then recently ended ones —
  // "continue what that dead session was doing" is the most valuable case, so
  // restricting the picker to live sessions would cut the best use out.
  attachCandidates(workspace, selfId, ttlMs, maxAgeMs = 24 * 3600_000) {
    const rows = this._all(
      `SELECT * FROM sessions
        WHERE workspace = ? AND session_id != COALESCE(?, '') AND last_seen > ?
        ORDER BY last_seen DESC LIMIT 40`,
      workspace, selfId ?? '', Date.now() - maxAgeMs);
    const cutoff = Date.now() - ttlMs;
    const mergeKey = r => `${r.agent || '?'}|${r.link_key}`;
    const realKeys = new Set(rows.filter(r => !r.synthetic && r.link_key).map(mergeKey));
    return rows
      .filter(r => !(r.synthetic && r.link_key && realKeys.has(mergeKey(r))))
      .map(r => ({
        ...r,
        live: r.status !== 'ended' && r.last_seen >= cutoff && isPidAlive(r.agent_pid ?? r.pid),
      }));
  }

  queueAttach({ workspace, target_id, target_name, ttlMs, adopt = 0 }) {
    // Only one pending request per workspace: a queue of stale intentions is
    // a footgun, and the last thing you asked for is what you meant.
    this._run('DELETE FROM attachments WHERE workspace = ? AND consumed_by IS NULL', workspace);
    const now = Date.now();
    const r = this._run(
      `INSERT INTO attachments(workspace,target_id,target_name,requested_at,expires_at,adopt)
       VALUES(?,?,?,?,?,?)`,
      workspace, target_id, target_name, now, now + ttlMs, adopt ? 1 : 0);
    return r ? Number(r.lastInsertRowid) : null;
  }

  pendingAttach(workspace) {
    return this._get(
      `SELECT * FROM attachments
        WHERE workspace = ? AND consumed_by IS NULL AND expires_at > ?
        ORDER BY requested_at DESC LIMIT 1`,
      workspace, Date.now());
  }

  consumeAttach(id, sessionId) {
    this._run('UPDATE attachments SET consumed_by=?, consumed_at=? WHERE id=? AND consumed_by IS NULL',
      sessionId, Date.now(), id);
  }

  cancelAttach(workspace) {
    this._run('DELETE FROM attachments WHERE workspace=? AND consumed_by IS NULL', workspace);
  }

  // Adopting claims is only safe from a session that is genuinely gone —
  // stealing a live session's files would cause the collision the product
  // exists to prevent.
  transferClaims(fromId, toId, ttlMs) {
    const from = this.getSession(fromId);
    if (!from) return 0;
    const live = from.status !== 'ended' && isPidAlive(from.agent_pid ?? from.pid);
    if (live) return 0;
    const claims = this._all('SELECT * FROM claims WHERE session_id=?', fromId);
    for (const c of claims) {
      this.addClaim({ path: c.path, session_id: toId, workspace: c.workspace,
        ttlMs, op: c.op, observed: 0, reason: `adopted from ${from.name || fromId}` });
    }
    this._run('DELETE FROM claims WHERE session_id=?', fromId);
    return claims.length;
  }

  notesBySession(sessionId, limit = 20) {
    return this._all('SELECT * FROM notes WHERE session_id=? ORDER BY created_at DESC LIMIT ?',
      sessionId, limit);
  }

  // ---- events (local-only effectiveness telemetry, §14) -------------------

  event(kind, { session_id, workspace, tokens = 0, detail = null } = {}) {
    this._run('INSERT INTO events(ts,session_id,workspace,kind,tokens,detail) VALUES(?,?,?,?,?,?)',
      Date.now(), session_id ?? null, workspace ?? null, kind, tokens, detail);
  }

  stats(workspace) {
    const rows = this._all(
      'SELECT kind, COUNT(*) n, COALESCE(SUM(tokens),0) tok FROM events WHERE workspace=? GROUP BY kind',
      workspace);
    const out = {};
    for (const r of rows) out[r.kind] = { count: r.n, tokens: r.tok };
    return out;
  }

  close() { try { this.db?.close(); } catch { /* ignore */ } }
}

function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

// FTS5 MATCH is a query language; user text must not be parsed as syntax.
function ftsEscape(q) {
  const terms = String(q).split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`);
  return terms.length ? terms.join(' OR ') : '""';
}

function isPidAlive(pid) {
  if (!pid) return true;              // unknown pid: don't reap on missing data
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }  // EPERM = alive but not ours
}

function isPidAliveForSession(store, sessionId) {
  const s = store.getSession(sessionId);
  if (!s) return false;
  if (s.status === 'ended') return false;
  return isPidAlive(s.agent_pid ?? s.pid);
}

module.exports = { Store, SCHEMA_VERSION, isPidAlive, ftsEscape };
