'use strict';
// The cross-repo index. One file, ~/.switchboard/index.db, listing which repos
// currently have live agent sessions.
//
// This is the ONLY switchboard state that lives outside a repo, and it exists
// for exactly one reason: `switchboard-adv` has to be able to answer "which
// repos are open right now?" before it knows which repo you mean.
//
// What it stores is deliberately thin — workspace path, session name, agent,
// pid, last_seen. No intent, no file lists, no commands, no notes. Content
// never leaves its repo, so a leak here exposes directory names, not work.
// Per-repo isolation (src/store.js) is unaffected: nothing reads this file
// except advanced mode.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isPidAlive } = require('./store');

// Resolved per call, not cached at module load: the test suite swaps HOME.
// SWITCHBOARD_HOME is the override — the registry is reached from deep inside
// registerSession, where there is no options object to thread a path through,
// and a test that writes a real ~/.switchboard is a bug we have already had
// once. It doubles as the escape hatch for sandboxed or read-only homes.
function dir()  { return path.join(process.env.SWITCHBOARD_HOME || os.homedir(), '.switchboard'); }
function file() { return path.join(dir(), 'index.db'); }

// Everything here is best-effort. The registry going missing must never break
// a session — it only ever degrades `switchboard-adv` to "no repos found".
function open() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dir(), { recursive: true });
    const db = new DatabaseSync(file());
    db.exec('PRAGMA busy_timeout=1000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS open_sessions (
        session_id TEXT PRIMARY KEY,
        workspace  TEXT NOT NULL,
        name       TEXT,
        agent      TEXT,
        pid        INTEGER,
        last_seen  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_open_ws ON open_sessions(workspace);
    `);
    return db;
  } catch { return null; }
}

function withDb(fn, fallback) {
  const db = open();
  if (!db) return fallback;
  try { return fn(db); }
  catch { return fallback; }
  finally { try { db.close(); } catch { /* already gone */ } }
}

// Called on every session heartbeat. Cheap by design — one upsert, no reads.
// `at` defaults to now. It exists because Date.now() has millisecond
// resolution: several sessions registering in the same tick would otherwise
// tie, making "most recent repo first" non-deterministic.
function record({ session_id, workspace, name, agent, pid, at }) {
  if (!session_id || !workspace) return false;
  return withDb(db => {
    db.prepare(
      `INSERT INTO open_sessions(session_id, workspace, name, agent, pid, last_seen)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace=excluded.workspace, name=excluded.name,
         agent=excluded.agent, pid=excluded.pid, last_seen=excluded.last_seen`
    ).run(session_id, workspace, name ?? null, agent ?? null, pid ?? null, at ?? Date.now());
    return true;
  }, false);
}

function forget(session_id) {
  if (!session_id) return false;
  return withDb(db => {
    db.prepare('DELETE FROM open_sessions WHERE session_id = ?').run(session_id);
    return true;
  }, false);
}

// `switchboard purge` wipes a repo's store. Without this, the global index
// would keep advertising that repo and `switchboard-adv` would offer sessions
// whose context no longer exists — a link that silently resolves to nothing.
function forgetWorkspace(workspace) {
  if (!workspace) return 0;
  return withDb(db => {
    const before = db.prepare('SELECT COUNT(*) n FROM open_sessions WHERE workspace = ?').get(workspace).n;
    db.prepare('DELETE FROM open_sessions WHERE workspace = ?').run(workspace);
    return before;
  }, 0);
}

// Rows whose process is gone are deleted on read rather than on a timer —
// there is no daemon, so the next reader is the only one who can clean up.
// A row for a repo that no longer exists on disk is dropped too: offering to
// connect to a deleted directory is worse than offering nothing.
function prune(db, staleMs = 12 * 3600_000) {
  const now = Date.now();
  const dead = [];
  for (const r of db.prepare('SELECT session_id, workspace, pid, last_seen FROM open_sessions').all()) {
    const gone = r.pid ? !isPidAlive(r.pid) : (now - r.last_seen) > 120_000;
    if (gone || (now - r.last_seen) > staleMs || !fs.existsSync(r.workspace)) dead.push(r.session_id);
  }
  if (dead.length) {
    const stmt = db.prepare('DELETE FROM open_sessions WHERE session_id = ?');
    for (const id of dead) stmt.run(id);
  }
  return dead.length;
}

// The whole point of this module: repos that are open right now, each with its
// live sessions nested underneath. Sorted most-recently-active first, because
// that is almost always the one you want.
function openRepos({ excludeSession = null } = {}) {
  return withDb(db => {
    prune(db);
    const rows = db.prepare(
      `SELECT session_id, workspace, name, agent, pid, last_seen
         FROM open_sessions
        WHERE session_id != COALESCE(?, '')
        ORDER BY last_seen DESC, workspace ASC, session_id ASC`
    ).all(excludeSession);

    const byWs = new Map();
    for (const r of rows) {
      if (!byWs.has(r.workspace)) byWs.set(r.workspace, { workspace: r.workspace, sessions: [], last_seen: r.last_seen });
      const e = byWs.get(r.workspace);
      e.sessions.push(r);
      e.last_seen = Math.max(e.last_seen, r.last_seen);
    }
    return [...byWs.values()].sort((a, b) => b.last_seen - a.last_seen);
  }, []);
}

// `switchboard-adv --purge`, and the uninstaller.
function clear() {
  try { fs.rmSync(file(), { force: true }); return true; } catch { return false; }
}

module.exports = { record, forget, forgetWorkspace, openRepos, clear, dir, file, prune };
