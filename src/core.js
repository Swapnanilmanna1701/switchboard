'use strict';
// Shared operations used by BOTH entry points (MCP server and hook handler),
// so the two views of a session never drift apart.

const fs = require('node:fs');
const W = require('./workspace');
const { Store } = require('./store');
const D = require('./digest');

// ADR-8: opening a context never throws. A caller that gets ok:false simply
// does nothing and exits 0.
function openContext(cwd) {
  const workspace = W.resolveWorkspace(cwd);
  const store = new Store(W.storePath(workspace));
  return { workspace, store, ok: store.ok, cwd: cwd || process.cwd() };
}

// Gather everything renderRoster/renderRosterFile need, in one place.
function rosterContext(store, workspace, selfId, ttlMs = W.DEFAULTS.liveTtlMs) {
  const peers = store.livePeers(workspace, selfId, ttlMs);
  const claimsBySession = {};
  const digestBySession = {};
  for (const p of peers) {
    claimsBySession[p.session_id] = store.claimsFor(p.session_id);
    digestBySession[p.session_id] = store.getDigest(p.session_id);
  }
  return { workspace, peers, claimsBySession, digestBySession, now: Date.now() };
}

// T2 (§10.3): keep .switchboard/ROSTER.md current so agents with neither MCP
// nor hooks still get the roster. Cheap, so it runs on every state change.
function writeRoster(store, workspace) {
  try {
    const ctx = rosterContext(store, workspace, null);
    W.writeFileAtomic(W.rosterPath(workspace), D.renderRosterFile(ctx.peers, ctx));
    return true;
  } catch { return false; }
}

// The text injected at session start, already wrapped as untrusted data
// (§13.8). Returns '' when there are no peers — FR-3.4, zero-cost path.
function injectionText(store, workspace, selfId, opts = {}) {
  const ctx = rosterContext(store, workspace, selfId, opts.ttlMs ?? W.DEFAULTS.liveTtlMs);
  if (!ctx.peers.length) return { text: '', tokens: 0, peers: 0 };
  const body = D.renderRoster(ctx.peers, ctx, opts);
  if (!body) return { text: '', tokens: 0, peers: ctx.peers.length };
  const text = D.wrapForInjection(body);
  return { text, tokens: D.estimateTokens(text), peers: ctx.peers.length };
}

// One registration path for every agent, whether the caller is the MCP server
// (ADR-0) or a hook. `tier` is max()'d in the store, so a hook upgrading a
// session from T1 to T3 never gets downgraded by a later MCP heartbeat.
function registerSession(store, {
  session_id, cwd, workspace, agent, agent_ver, name, tier, agent_pid, intent, status, synthetic,
}) {
  return store.upsertSession({
    session_id,
    link_key: W.linkKey(cwd, agent_pid),
    pid: process.pid,
    agent_pid,
    name, agent, agent_ver, tier, synthetic,
    cwd, workspace,
    started_at: Date.now(),
    status: status ?? 'active',
    intent: intent ? D.redact(D.truncate(D.collapse(intent), 200)) : null,
  });
}

// Resolve the identity a session should be stored under.
// For Claude Code we can read the real session id from its own registry
// (§10.6), so the MCP row and the hook row converge. Everywhere else we key on
// the agent pid, which is stable for the life of the session.
// ponytail: pid-keyed identity, one row per agent process. If an agent ever
// runs several logical sessions in one process, key on its own session id
// instead — the store already accepts any string.
function resolveIdentity({ agent, cwd, agent_pid }) {
  if (agent === 'claude-code' && agent_pid) {
    const s = W.claudeSessionByPid(agent_pid);
    if (s?.session_id) {
      return { session_id: s.session_id, name: s.name, agent_ver: s.version, synthetic: 0 };
    }
  }
  // No authoritative id available: derive one from the agent pid and mark it
  // synthetic, so a hook that later registers the real id absorbs this row
  // instead of appearing as a second session.
  return {
    session_id: `${agent || 'agent'}-${agent_pid || process.pid}`,
    name: null, agent_ver: null, synthetic: 1,
  };
}

// Derive a readable session name when the agent doesn't give us one.
// Keyed on the SESSION id, never the pid: two sessions of the same agent can
// share a parent process, and two peers with the same name make sb_session()
// ambiguous — which is worse than an ugly name.
function deriveName(agent, workspace, sessionId) {
  const base = require('node:path').basename(workspace || 'workspace');
  const short = require('node:crypto')
    .createHash('sha1').update(String(sessionId || process.pid)).digest('hex').slice(0, 4);
  return `${base}-${short}`;
}

// ---- attach ----------------------------------------------------------------

// Gather one session's ENTIRE recorded context, for an explicit takeover.
function attachContext(store, workspace, targetId, opts = {}) {
  const session = store.getSession(targetId);
  if (!session) return null;
  const W2 = require('./workspace');
  const live = session.status !== 'ended' &&
    (Date.now() - session.last_seen) < (opts.ttlMs ?? W2.DEFAULTS.liveTtlMs) &&
    require('./store').isPidAlive(session.agent_pid ?? session.pid);
  return {
    session: { ...session, live },
    digest: store.getDigest(targetId),
    claims: store.claimsFor(targetId),
    notes: store.notesBySession(targetId),
    workspace,
  };
}

// Resolve a user-typed name to a session. Accepts the display name, a full
// session id, or a unique prefix — people type what they see.
function findTarget(store, workspace, needle, selfId) {
  const want = String(needle || '').toLowerCase().trim();
  if (!want) return null;
  const all = store.attachCandidates(workspace, selfId, W.DEFAULTS.liveTtlMs);
  return all.find(s => (s.name || '').toLowerCase() === want)
      || all.find(s => s.session_id.toLowerCase() === want)
      || all.find(s => (s.name || '').toLowerCase().startsWith(want))
      || all.find(s => s.session_id.toLowerCase().startsWith(want))
      || null;
}

// Render the takeover payload, wrapped as untrusted peer data (§13.8), and
// optionally adopt the target's file claims when it is genuinely gone.
function performAttach(store, workspace, target, receivingSessionId, { adopt = false } = {}) {
  const D2 = require('./digest');
  const ctx = attachContext(store, workspace, target.session_id);
  if (!ctx) return null;

  let adopted = 0;
  if (adopt && !ctx.session.live) {
    adopted = store.transferClaims(target.session_id, receivingSessionId, W.DEFAULTS.claimTtlMs);
  }

  // Inherit the intent so the roster shows this session continuing that work.
  if (ctx.session.intent) {
    const me = store.getSession(receivingSessionId);
    if (me && !me.intent) store.upsertSession({ session_id: receivingSessionId, intent: ctx.session.intent });
  }

  const body = D2.renderAttachContext(ctx);
  const text = D2.wrapForInjection(body);
  store.event('attach', {
    session_id: receivingSessionId, workspace,
    tokens: D2.estimateTokens(text),
    detail: `${target.name || target.session_id}${adopted ? ` +${adopted} claims` : ''}`,
  });
  writeRoster(store, workspace);
  return { text, adopted, live: ctx.session.live, name: target.name || target.session_id };
}

// Housekeeping run on every entry point: reap dead sessions, expire claims,
// refresh the roster file. Cheap enough to be unconditional (FR-2.4).
function sweep(store, workspace, ttlMs = W.DEFAULTS.liveTtlMs) {
  const reaped = store.reap(ttlMs);
  if (reaped) store.event('reap', { workspace, detail: String(reaped) });
  writeRoster(store, workspace);
  return reaped;
}

// Ensure the store directory exists and is git-excluded (FR-1.7, §13.6).
function ensureStoreDir(workspace) {
  const dir = W.storeDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  W.gitExclude(workspace, '.switchboard/');
  return dir;
}

module.exports = {
  openContext, rosterContext, writeRoster, injectionText,
  registerSession, resolveIdentity, deriveName, sweep, ensureStoreDir,
  attachContext, findTarget, performAttach,
};
