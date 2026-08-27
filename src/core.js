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

// How much the AMBIENT layer is allowed to spend. Nothing here changes what
// you can pull on demand — only what arrives uninvited.
//
//   full  ~150 tok  the roster: who is live, what they're on, what they hold
//   lean   ~18 tok  one line saying peers exist; the model pulls if it cares
//   off       0 tok  nothing arrives unless a tool is called
//
// A model can only use what is in its context, so "know about peers for free"
// is not achievable — but the FLOOR can be zero, and `lean` gets 88% of the
// value for 12% of the cost.
function readMode(workspace) {
  try {
    const cfg = JSON.parse(fs.readFileSync(require('node:path').join(W.storeDir(workspace), 'config.json'), 'utf8'));
    return ['full', 'lean', 'off'].includes(cfg.mode) ? cfg.mode : 'full';
  } catch { return 'full'; }
}

function writeMode(workspace, mode) {
  const p = require('node:path').join(W.storeDir(workspace), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* new */ }
  cfg.mode = mode;
  fs.mkdirSync(W.storeDir(workspace), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}

// SCOPE is a different axis from MODE. Mode is how many tokens the ambient
// layer may spend; scope is what a session is allowed to reach at all.
//
//   normal    (default) live sessions, this repo only. An ended session is
//             invisible and cannot be attached to — the past is not context.
//   advanced  live sessions across every open repo. Opt-in per session, and
//             only via `switchboard-adv` run in a terminal *before* the agent
//             starts, so crossing a repo boundary is always a human decision.
//
// Defaulting to `normal` matters: cross-repo context is the kind of thing that
// should never happen because a config file drifted.
function readScope(workspace) {
  try {
    const cfg = JSON.parse(fs.readFileSync(require('node:path').join(W.storeDir(workspace), 'config.json'), 'utf8'));
    return cfg.scope === 'advanced' ? 'advanced' : 'normal';
  } catch { return 'normal'; }
}

function writeScope(workspace, scope) {
  const p = require('node:path').join(W.storeDir(workspace), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* new */ }
  cfg.scope = scope === 'advanced' ? 'advanced' : 'normal';
  fs.mkdirSync(W.storeDir(workspace), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}

// ---- cross-repo link (advanced) --------------------------------------------
//
// `switchboard-adv` runs in a terminal, picks a session in another repo, and
// leaves this file behind. The next session that starts in this repo consumes
// it exactly once. A file rather than a table because the two ends are in
// different repos with different databases, and neither should write to the
// other's store.
const LINK_TTL_MS = 60 * 60_000;   // an hour: you either start the agent or you don't

function linkPath(workspace) { return require('node:path').join(W.storeDir(workspace), 'link.json'); }

function writeLink(workspace, target) {
  const p = linkPath(workspace);
  fs.mkdirSync(W.storeDir(workspace), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({ ...target, created_at: Date.now() }, null, 2)}\n`);
  return p;
}

function readLink(workspace) {
  try {
    const link = JSON.parse(fs.readFileSync(linkPath(workspace), 'utf8'));
    if (!link.workspace || !link.session_id) return null;
    if (Date.now() - (link.created_at ?? 0) > LINK_TTL_MS) return null;  // stale intent is not intent
    return link;
  } catch { return null; }
}

// One-shot. Reading it consumes it, so a link never silently applies to a
// second session you started for an unrelated reason.
function consumeLink(workspace) {
  const link = readLink(workspace);
  try { fs.rmSync(linkPath(workspace), { force: true }); } catch { /* best effort */ }
  return link;
}

// Pull the linked session's context out of ITS OWN repo store. This is the one
// place switchboard reads across a repo boundary, and it is reachable only
// after a human picked that session in a terminal.
function crossRepoContext(link, opts = {}) {
  if (!link) return null;
  const { Store } = require('./store');
  const D2 = require('./digest');
  let store;
  try {
    store = new Store(W.storePath(link.workspace));
    if (!store.ok) return null;
    const session = store.getSession(link.session_id);
    if (!session) return null;
    const body = D2.renderAttachContext({
      session: { ...session, live: true },
      digest: store.getDigest(link.session_id),
      claims: store.claimsFor(link.session_id),
      notes:  store.notesBySession(link.session_id),
      workspace: link.workspace,
    }, { maxTokens: opts.maxTokens ?? 2000 });
    const header = `[switchboard] connected to ${session.name || link.session_id} in ${link.workspace}\n`;
    return { text: D2.wrapForInjection(header + body), body, session, workspace: link.workspace };
  } catch { return null; }
  finally { try { store?.close(); } catch { /* already closed */ } }
}

// The text injected at session start, already wrapped as untrusted data
// (§13.8). Returns '' when there are no peers — FR-3.4, zero-cost path.
function injectionText(store, workspace, selfId, opts = {}) {
  const mode = opts.mode ?? readMode(workspace);
  if (mode === 'off') return { text: '', tokens: 0, peers: 0, mode };

  const ctx = rosterContext(store, workspace, selfId, opts.ttlMs ?? W.DEFAULTS.liveTtlMs);
  if (!ctx.peers.length) return { text: '', tokens: 0, peers: 0, mode };

  if (mode === 'lean') {
    // A pointer, not a payload. The model spends the rest only if it decides
    // the peers matter — ADR-1 taken to its limit.
    //
    // No untrusted-data envelope here: this line contains a COUNT and nothing
    // a peer wrote, so there is no injected content to defend against. The
    // envelope is ~50 tokens and would be most of the cost of the mode whose
    // entire purpose is being cheap.
    const n = ctx.peers.length;
    const text = `[switchboard] ${n} other session${n === 1 ? '' : 's'} live in this workspace. ` +
                 'Call sb_peers if that matters.';
    return { text, tokens: D.estimateTokens(text), peers: n, mode };
  }

  const body = D.renderRoster(ctx.peers, ctx, opts);
  if (!body) return { text: '', tokens: 0, peers: ctx.peers.length, mode };
  const text = D.wrapForInjection(body);
  return { text, tokens: D.estimateTokens(text), peers: ctx.peers.length, mode };
}

// One registration path for every agent, whether the caller is the MCP server
// (ADR-0) or a hook. `tier` is max()'d in the store, so a hook upgrading a
// session from T1 to T3 never gets downgraded by a later MCP heartbeat.
function registerSession(store, {
  session_id, cwd, workspace, agent, agent_ver, name, alias, tier, agent_pid, intent, status, synthetic,
}) {
  const out = store.upsertSession({
    session_id,
    link_key: W.linkKey(cwd, agent_pid),
    pid: process.pid,
    agent_pid,
    name, alias, agent, agent_ver, tier, synthetic,
    cwd, workspace,
    started_at: Date.now(),
    status: status ?? 'active',
    intent: intent ? D.redact(D.truncate(D.collapse(intent), 200)) : null,
  });
  // Mirror the bare fact "this repo has a live session" into the cross-repo
  // index so `switchboard-adv` can find it. Metadata only — never the intent,
  // which stays in this repo's store. Best-effort: a failure here must not
  // affect the session, so registry.record swallows its own errors.
  if (out) {
    require('./registry').record({
      session_id, workspace, agent,
      pid: agent_pid ?? process.pid,
      name: out.name ?? name ?? null,
    });
  }
  return out;
}

// ---- @mentions -------------------------------------------------------------

// Pull candidate @tags out of a prompt: @fix-auth-tokens, @logline2-d1.
// Deliberately permissive here and strict at resolution time — a tag that
// doesn't match a real session injects NOTHING, so an email address or a
// decorator in pasted code can never trigger a false injection.
function parseMentions(prompt) {
  const out = [];
  const re = /(^|[\s(\[{,'"`])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
  let m;
  while ((m = re.exec(String(prompt || '')))) out.push(m[2]);
  return [...new Set(out)];
}

// Resolve @tags to sessions. Only exact matches count: the session's name,
// the agent's own name for it, or its id. No prefix guessing — silently
// injecting the wrong session's context would be worse than doing nothing.
function resolveMentions(store, workspace, prompt, selfId) {
  const tags = parseMentions(prompt);
  if (!tags.length) return [];
  // Normal scope: a @tag can only ever resolve to a LIVE session in this repo.
  // Naming an ended session must miss, not quietly resurrect it.
  let all = store.attachCandidates(workspace, selfId, W.DEFAULTS.liveTtlMs);
  if (readScope(workspace) !== 'advanced') all = all.filter(s => s.live);
  const hits = [];
  for (const tag of tags) {
    const want = tag.toLowerCase();
    const found = all.find(s => (s.name || '').toLowerCase() === want)
      || all.find(s => (s.alias || '').toLowerCase() === want)   // native @ typeahead
      || all.find(s => s.session_id.toLowerCase() === want)
      || null;
    if (found && !hits.some(h => h.session.session_id === found.session_id)) {
      hits.push({ tag, session: found });
    }
  }
  return hits;
}

// The full directory: every session in this workspace, live and ended, with
// its handle. Backs bare `/sbs` and `@sbs` — look before you act.
// Live sessions only, unless `all` is asked for. An ended session is still
// attachable, but a list dominated by yesterday's corpses is noise — you
// almost always mean "what is running right now".
function sessionIndex(store, workspace, selfId, opts = {}) {
  const D2 = require('./digest');
  let sessions = store.attachCandidates(workspace, selfId, W.DEFAULTS.liveTtlMs, opts.maxAgeMs);
  const endedCount = sessions.filter(s => !s.live).length;
  // `--all` only widens the list in advanced scope. In normal scope ended
  // sessions are not reachable, so offering them in a picker would be a lie.
  const advanced = readScope(workspace) === 'advanced';
  if (!opts.all || !advanced) sessions = sessions.filter(s => s.live);
  const claimsBySession = {};
  const digestBySession = {};
  for (const s of sessions) {
    claimsBySession[s.session_id] = store.claimsFor(s.session_id);
    digestBySession[s.session_id] = store.getDigest(s.session_id);
  }
  const body = D2.renderSessionIndex(sessions, { workspace, claimsBySession, digestBySession, endedCount, all: !!opts.all }, opts);
  return { body, sessions, endedCount, text: D2.wrapForInjection(body), tokens: D2.estimateTokens(body) };
}

// Build the context block for every @mentioned session in one prompt.
function mentionText(store, workspace, prompt, selfId, opts = {}) {
  // "@sbs stop" / "@sbs clear" drops every active reference. A sticky
  // reference you cannot turn off is a leak, not a feature.
  if (/@sbs\s+(stop|clear|off|none)\b/i.test(String(prompt || ''))) {
    const n = store.refsFor(selfId).length;
    store.clearRefs(selfId);
    return { text: '', tokens: 0, tags: ['sbs'], cleared: n };
  }

  // Bare `@sbs` means "show me the index", not "resolve a session".
  if (parseMentions(prompt).some(t => /^sbs$/i.test(t))) {
    const idx = sessionIndex(store, workspace, selfId, opts);
    return { text: idx.text, tokens: idx.tokens, tags: ['sbs'], index: true };
  }

  const hits = resolveMentions(store, workspace, prompt, selfId);
  if (!hits.length) return { text: '', tokens: 0, tags: [] };

  const D2 = require('./digest');
  const per = Math.max(200, Math.floor((opts.maxTokens ?? 1200) / hits.length));
  const blocks = hits.map(({ tag, session }) => {
    const ctx = attachContext(store, workspace, session.session_id);
    return `@${tag}:\n${D2.renderSessionDetail(ctx, { maxTokens: per })}`;
  });

  const body = `You referenced ${hits.length} session${hits.length === 1 ? '' : 's'} by @tag:\n\n${blocks.join('\n\n')}`;
  const text = D2.wrapForInjection(body);
  return { text, tokens: D2.estimateTokens(text), tags: hits.map(h => h.tag), hits };
}

// ---- active (sticky) references --------------------------------------------

// Once you @tag a session, it stays REFERENCED. Later turns pick up whatever
// that session has done since, without you re-typing the tag — the point of a
// reference is that it persists, otherwise it is just a one-off lookup.
function rememberRefs(store, workspace, sessionId, hits) {
  for (const { session } of hits) {
    const d = store.getDigest(session.session_id);
    store.addRef(sessionId, session.session_id, workspace, d?.updated_at ?? 0);
  }
}

// What has changed in the sessions this one references, since we last said so.
// Silent when nothing moved — a reference that chatters every turn is worse
// than no reference at all.
function refDelta(store, workspace, sessionId, opts = {}) {
  const refs = store.refsFor(sessionId);
  if (!refs.length) return { text: '', tokens: 0, changed: [] };

  const D2 = require('./digest');
  const changed = [];
  for (const r of refs) {
    const target = store.getSession(r.target_id);
    if (!target || target.status === 'ended') continue;
    const d = store.getDigest(r.target_id);
    const stamp = d?.updated_at ?? 0;
    if (stamp <= (r.last_seen ?? 0)) continue;          // nothing new
    changed.push({ target, digest: d, stamp });
  }
  if (!changed.length) return { text: '', tokens: 0, changed: [] };

  const per = Math.max(120, Math.floor((opts.maxTokens ?? 400) / changed.length));
  const blocks = changed.map(({ target, digest }) => {
    const nm = target.name || target.session_id.slice(0, 8);
    const bits = [];
    if (digest?.last_msg) bits.push(digest.last_msg);
    const claims = store.claimsFor(target.session_id);
    if (claims.length) bits.push(`now on: ${claims.slice(0, 3).map(c => D2.relTo(workspace, c.path)).join(', ')}`);
    return D2.capText(`• ${nm} — ${bits.join(' · ') || 'still working'}`, per);
  });

  for (const { target, stamp } of changed) store.touchRef(sessionId, target.session_id, stamp);

  const body = `Update from the session${changed.length === 1 ? '' : 's'} you are referencing:\n${blocks.join('\n')}`;
  const text = D2.wrapForInjection(body);
  return { text, tokens: D2.estimateTokens(text), changed };
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

// ---- semantic naming -------------------------------------------------------

// Words that carry no signal about what a session is FOR.
const STOP = new Set(`
a an the this that these those my our your its их
and or but so then than also just only very really quite
i we you it they he she them us me
is are was were be been being am do does did done doing
have has had having can could should would will shall may might must
to of in on at for from with by about into over under across as
please help lets let me us can you could would need want try trying
some any all every each other another new old current
thing things stuff code file files project repo repository
`.trim().split(/\s+/));

// A short, meaningful name built from what the session is actually doing.
// Mechanical, not an LLM call (ADR-2): this runs inside a hook with a 300ms
// budget, and a name is not worth a model round-trip.
function deriveLabel(intent, files = []) {
  const words = String(intent || '')
    .toLowerCase()
    .replace(/[`"'*_~]/g, '')
    .replace(/[^a-z0-9+#./-]+/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[./-]+|[./-]+$/g, ''))
    .filter(w => w.length > 1 && w.length < 20 && !STOP.has(w));

  const picked = [];
  for (const w of words) {
    if (picked.includes(w)) continue;
    picked.push(w);
    if (picked.join('-').length >= 22 || picked.length >= 4) break;
  }

  if (picked.length) return picked.join('-').slice(0, 28).replace(/-+$/, '');

  // No usable intent yet: name it after the file it is working in.
  const f = files.find(Boolean);
  if (f) {
    const stem = require('node:path').basename(String(f)).replace(/\.[a-z0-9]+$/i, '');
    if (stem) return `working-${stem}`.slice(0, 28);
  }
  return null;
}

// A one-line description for lists. Distinct from the name: the name is an
// address, this is what it is for.
function deriveDescription(intent, digest) {
  const src = intent || digest?.intent || digest?.last_msg || '';
  const s = D.collapse(src);
  if (!s) return null;
  // First sentence, if there is a natural one.
  const first = s.split(/(?<=[.!?])\s+/)[0];
  return D.truncate((first.length >= 15 ? first : s), 72);
}

// Assign a semantic name ONCE, the first time we learn what this session is
// doing. Never renamed afterwards: a name that changes underneath the user
// breaks every reference they have already made to it.
function nameFromWork(store, sessionId, workspace, { intent, files } = {}) {
  const cur = store.getSession(sessionId);
  if (!cur || cur.named) return cur?.name ?? null;

  const label = deriveLabel(intent ?? cur.intent, files);
  if (!label) return cur.name;

  // Two sessions can legitimately be doing the same thing; disambiguate rather
  // than let sb_session("fix-auth") become a coin flip.
  let name = label;
  const taken = new Set(
    store._all('SELECT name FROM sessions WHERE workspace=? AND session_id!=?', workspace, sessionId)
      .map(r => (r.name || '').toLowerCase()));
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${label}-${n++}`;

  store.upsertSession({ session_id: sessionId, name, named: 1 });
  return name;
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
  let all = store.attachCandidates(workspace, selfId, W.DEFAULTS.liveTtlMs);
  // Normal scope cannot attach to an ended session, so it must not be findable
  // by name either — otherwise attach fails somewhere deeper with a worse error.
  if (readScope(workspace) !== 'advanced') all = all.filter(s => s.live);

  return all.find(s => (s.name || '').toLowerCase() === want)
      // The agent's OWN session name: this is what Claude Code's native `@`
      // typeahead inserts, so it must resolve even after we rename a session
      // to something semantic.
      || all.find(s => (s.alias || '').toLowerCase() === want)
      || all.find(s => s.session_id.toLowerCase() === want)
      || all.find(s => (s.name || '').toLowerCase().startsWith(want))
      || all.find(s => (s.alias || '').toLowerCase().startsWith(want))
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
  parseMentions, resolveMentions, mentionText, sessionIndex,
  rememberRefs, refDelta, readMode, writeMode, readScope, writeScope,
  writeLink, readLink, consumeLink, crossRepoContext, linkPath,
  deriveLabel, deriveDescription, nameFromWork,
};
