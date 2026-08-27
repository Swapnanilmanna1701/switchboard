#!/usr/bin/env node
'use strict';
// CLI surface (§9.4): init · status · board · doctor · uninstall · purge

const fs = require('node:fs');
const path = require('node:path');
const W = require('../src/workspace');
const C = require('../src/core');
const D = require('../src/digest');
const I = require('../src/installers');
const { Store } = require('../src/store');
const pkg = require('../package.json');

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'help').replace(/^--?/, '');
const flags = new Set(argv.filter(a => a.startsWith('--')));
const has = f => flags.has(`--${f}`);

const c = {
  b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m`,
};
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
for (const k of Object.keys(c)) if (!supportsColor) c[k] = s => String(s);

const workspace = W.resolveWorkspace(process.cwd());

function main() {
  switch (cmd) {
    case 'init':      return init();
    case 'status':    return status();
    case 'board':     return board();
    case 'doctor':    return doctor();
    case 'uninstall': return uninstall();
    case 'purge':     return purge();
    case 'attach':    return attach();
    case 'sessions': case 'ls': return sessions();
    case 'sbs':  case 'pick': return sbs();
    case 'mode':      return mode();
    case 'statusline': return statusline();
    case 'version': case 'v': return console.log(pkg.version);
    default:          return help();
  }
}

// ---- init (FR-1.1 … FR-1.7) ------------------------------------------------

function init() {
  const dry = has('dry-run');
  const opts = { all: has('all'), local: has('local') };
  console.log(`${c.b('switchboard')} ${c.dim(`v${pkg.version}`)}`);
  console.log(`workspace: ${c.c(workspace)}\n`);

  const items = I.plan(workspace, opts);
  const detected = items.filter(i => i.detected || i.installed);
  if (!detected.length) {
    console.log(c.y('No supported agents detected in this workspace.'));
    console.log(c.dim('Run with --all to write configs for every supported agent anyway.'));
    return;
  }

  // FR-1.4: print the diff before touching anything.
  console.log(c.b('Plan:'));
  for (const i of items) {
    const tag = i.action === 'ok' ? c.dim('already set') : c.g('write');
    console.log(`  ${pad(i.label, 30)} ${pad(i.kind, 8)} ${tag}  ${c.dim(rel(i.file))}`);
  }

  if (dry) { console.log(`\n${c.y('--dry-run: nothing written.')}`); return; }

  const { written, failed } = I.apply(workspace, opts);
  C.ensureStoreDir(workspace);
  const store = new Store(W.storePath(workspace));
  C.writeRoster(store, workspace);
  store.close();

  console.log(`\n${c.g('✓')} wrote ${written.length} file change(s)`);
  for (const w of written) console.log(`  ${c.g('+')} ${rel(w.written)} ${c.dim(`(${w.label}, ${w.kind})`)}`);
  if (failed.length) {
    console.log(`\n${c.y('⚠')} ${failed.length} target(s) failed (others still installed):`);
    for (const f of failed) console.log(`  ${c.r('✗')} ${rel(f.file)} — ${f.error}`);
  }
  console.log(`\n${c.dim('Restart any running agent sessions to pick up the new config.')}`);
  console.log(c.dim('Check anytime with: switchboard doctor'));
}

// ---- status (FR-5.1 human view) -------------------------------------------

function status() {
  const store = new Store(W.storePath(workspace));
  if (!store.ok) return console.log(c.r('store unavailable:'), store.error?.message);
  C.sweep(store, workspace);

  if (has('raw')) {            // §13.7: everything stored, inspectable
    const dump = {
      sessions: store._all('SELECT * FROM sessions'),
      claims:   store._all('SELECT * FROM claims'),
      digests:  store._all('SELECT * FROM digests'),
      notes:    store._all('SELECT * FROM notes'),
      events:   store._all('SELECT * FROM events ORDER BY ts DESC LIMIT 200'),
    };
    console.log(JSON.stringify(dump, null, 2));
    return store.close();
  }

  const ctx = C.rosterContext(store, workspace, null);
  if (has('json')) { console.log(JSON.stringify(ctx, null, 2)); return store.close(); }

  console.log(`${c.b('switchboard')} ${c.dim(workspace)}\n`);
  if (!ctx.peers.length) {
    console.log(c.dim('No live sessions in this workspace.'));
  } else {
    for (const p of ctx.peers) {
      const claims = ctx.claimsBySession[p.session_id] || [];
      const d = ctx.digestBySession[p.session_id];
      const tier = p.tier >= 3 ? c.g('T3') : c.y('T1');
      const alias = p.alias && p.alias !== p.name ? c.dim(` aka ${p.alias}`) : '';
      console.log(`${c.b('•')} ${c.b(p.name || p.session_id.slice(0, 8))}${alias}  ${c.c(`[${W.agentLabel(p.agent)}]`)}  ${tier}  ${c.dim(`${p.status} ${D.ago(Date.now() - p.last_seen)}`)}`);
      const desc = D.describe(p, d);
      if (desc) console.log(`  ${D.truncate(D.collapse(desc), 90)}`);
      if (claims.length) {
        const prov = claims.every(x => x.observed) ? 'observed' : 'self-declared';
        console.log(`  ${c.dim(`editing (${prov}):`)} ${claims.slice(0, 5).map(x => D.relTo(workspace, x.path)).join(', ')}`);
      }
      if (d?.last_msg) console.log(`  ${c.dim('latest:')} ${D.truncate(D.collapse(d.last_msg), 100)}`);
      console.log();
    }
  }

  // §14 — the effectiveness numbers, local only.
  const s = store.stats(workspace);
  const injected = s.inject?.tokens || 0;
  const pulls = s.pull?.count || 0;
  const injects = s.inject?.count || 0;
  console.log(c.dim(`injections: ${injects} (${injected} tok) · pulls: ${pulls} · warnings: ${s.collision?.count || 0} · notes: ${s.note?.count || 0}`));
  if (injects > 0) console.log(c.dim(`pull-through: ${Math.round((pulls / injects) * 100)}%  ${c.dim('(target >25%, §14)')}`));
  store.close();
}

function board() {
  const draw = () => { process.stdout.write('\x1b[2J\x1b[H'); status(); };
  draw();
  setInterval(draw, 3000);
}

// ---- doctor (§9.4 — hook tools fail silently; this is not optional) --------

function doctor() {
  console.log(`${c.b('switchboard doctor')} ${c.dim(`v${pkg.version}`)}\n`);
  let problems = 0;

  const nodeOk = process.versions.node.split('.').map(Number)[0] >= 22;
  line('Node >= 22 (node:sqlite)', nodeOk, process.version);
  if (!nodeOk) problems++;

  let sqliteOk = false, ftsOk = false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    sqliteOk = true;
    try { db.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); ftsOk = true; } catch { /* degrade */ }
    db.close();
  } catch { /* reported below */ }
  line('node:sqlite available', sqliteOk);
  line('FTS5 search', ftsOk, ftsOk ? '' : 'degrades to LIKE — still correct');
  if (!sqliteOk) problems++;

  console.log(`\n${c.b('Workspace')}`);
  console.log(`  root:  ${workspace}`);
  console.log(`  store: ${rel(W.storePath(workspace))} ${fs.existsSync(W.storePath(workspace)) ? c.g('(exists)') : c.y('(not created yet)')}`);
  const store = new Store(W.storePath(workspace));
  line('store writable', store.ok, store.ok ? '' : store.error?.message);
  if (!store.ok) problems++;
  // A silently-empty store looks identical to a healthy one, so say it loudly.
  store._all('SELECT session_id, slot, synthetic FROM sessions LIMIT 1');
  line('schema up to date', !store.schemaError, store.schemaError || '');
  if (store.schemaError) { problems++; console.log(`    ${c.y('run `switchboard purge` to rebuild the store')}`); }
  if (store.migrated?.length) console.log(`  ${c.g('✓')} ${pad('migrated this run', 32)} ${c.dim(store.migrated.join(', '))}`);

  console.log(`\n${c.b('Agent configuration')}`);
  const items = I.plan(workspace, { all: true });
  const byAgent = new Map();
  for (const i of items) {
    // Context rows (AGENTS.md, the CLAUDE.md bridge) are reported separately
    // below; folding them in here overwrote the agent's real label and tier.
    if (i.agent === 'all' || i.kind === 'context') continue;
    const e = byAgent.get(i.agent) || { label: i.label, mcp: false, hook: false, detected: false };
    if (i.kind === 'mcp' && i.installed) e.mcp = true;
    if (i.kind === 'hook' && i.installed) e.hook = true;
    if (i.detected) e.detected = true;
    byAgent.set(i.agent, e);
  }
  for (const [agent, e] of byAgent) {
    const capable = W.AGENTS[agent]?.hooks;
    const tier = e.mcp && e.hook ? c.g('T3') : e.mcp ? c.y('T1') : c.dim('--');
    const notes = [];
    if (e.mcp) notes.push('mcp');
    if (e.hook) notes.push('hooks');
    if (!e.mcp && e.detected) notes.push(c.y('detected, not configured'));
    if (!e.detected && !e.mcp) notes.push(c.dim('not installed'));
    if (capable && e.mcp && !e.hook) notes.push(c.y('hooks available but unconfigured'));
    console.log(`  ${pad(e.label, 22)} ${tier}  ${notes.join(', ')}`);
  }

  const a = I.agentsMd(workspace);
  console.log(`\n${c.b('Cross-agent context')}`);
  line('AGENTS.md stanza', a.installed(), rel(a.file));
  line('CLAUDE.md bridge', I.claudeBridge(workspace).installed(), rel(path.join(workspace, 'CLAUDE.md')));
  line('ROSTER.md present', fs.existsSync(W.rosterPath(workspace)), rel(W.rosterPath(workspace)));

  // §11.8 — sandboxing is detected and reported, never failed silently.
  console.log(`\n${c.b('Environment')}`);
  line('git repo', !!W.gitRoot(workspace));
  line('cross-session messaging socket', !!process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    process.env.CLAUDE_CODE_MESSAGING_SOCKET ? 'sb_handoff can deliver natively' : 'sb_handoff returns text to relay');

  store.close();
  console.log(problems ? `\n${c.r(`${problems} problem(s) found.`)}` : `\n${c.g('✓ all good')}`);
}

function line(label, ok, note = '') {
  console.log(`  ${ok ? c.g('✓') : c.y('•')} ${pad(label, 32)} ${c.dim(note)}`);
}

// ---- uninstall / purge (FR-1.6, §13.7) ------------------------------------

function uninstall() {
  const { removed, failed } = I.revert(workspace, {});
  console.log(`${c.g('✓')} reverted ${removed.length} file change(s)`);
  for (const r of removed) console.log(`  ${c.r('-')} ${rel(r.removed)} ${c.dim(`(${r.label})`)}`);
  for (const f of failed) console.log(`  ${c.y('!')} ${rel(f.file)} — ${f.error}`);
  if (has('purge')) purge();
  else console.log(c.dim(`\nStore kept at ${rel(W.storeDir(workspace))}. Remove it with: switchboard purge`));
}

function purge() {
  try {
    fs.rmSync(W.storeDir(workspace), { recursive: true, force: true });
    console.log(`${c.g('✓')} removed ${rel(W.storeDir(workspace))}`);
  } catch (e) { console.log(c.r(`purge failed: ${e.message}`)); }
}

// ---- sbs: the arrow-key picker ---------------------------------------------

// Browse with arrows, hit enter, then start your session. The whole browse
// costs ZERO tokens because it happens in the terminal — the model only ever
// sees the ONE session you chose, injected at SessionStart.
function sbs() {
  const store = new Store(W.storePath(workspace));
  if (!store.ok) return console.log(c.r('store unavailable — run `switchboard init` first'));
  C.sweep(store, workspace);

  const idx = C.sessionIndex(store, workspace, null, { maxTokens: 8000, all: has('all') });
  if (!idx.sessions.length) {
    console.log(c.y(idx.endedCount ? 'No sessions are live in this workspace.' : 'No sessions recorded in this workspace yet.'));
    console.log(c.dim(idx.endedCount
      ? `${idx.endedCount} ended session(s) can still be continued: switchboard sbs --all`
      : 'Start a session here first, then come back.'));
    return store.close();
  }

  // Direct selection: `switchboard sbs 2` (list position) or a name. No UI, so
  // selecting never depends on having a raw-mode terminal.
  const arg = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  if (arg) {
    const n = Number(arg);
    const chosen = (Number.isInteger(n) && n >= 1 && n <= idx.sessions.length)
      ? idx.sessions[n - 1]
      : C.findTarget(store, workspace, arg, null);
    if (!chosen) {
      console.log(c.y(`No session matches "${arg}".`));
      console.log(c.dim('Run `switchboard sessions` to see them, or `switchboard sbs` to pick.'));
      return store.close();
    }
    return select(chosen);
  }

  const ctx = {
    workspace,
    claimsBySession: Object.fromEntries(idx.sessions.map(s => [s.session_id, store.claimsFor(s.session_id)])),
    digestBySession: Object.fromEntries(idx.sessions.map(s => [s.session_id, store.getDigest(s.session_id)])),
  };

  require('../src/picker').pick(idx.sessions, ctx).then(chosen => {
    if (!chosen) {
      console.log(c.dim('cancelled — nothing queued'));
      return store.close();
    }
    select(chosen);
  });

  function select(chosen) {
    const nm = chosen.name || chosen.session_id.slice(0, 8);
    const handle = nm;
    store.queueAttach({
      workspace, target_id: chosen.session_id, target_name: nm,
      ttlMs: 15 * 60_000, adopt: has('adopt') && !chosen.live ? 1 : 0,
    });
    console.log(`${c.g('✓')} selected ${c.b(handle)}${handle === nm ? '' : c.dim(` (${nm})`)}` +
      `  ${c.dim(chosen.live ? 'live' : 'ended')}`);
    console.log(c.dim(`  its full context will load into the next session started here`));
    store.close();

    if (has('run')) {
      console.log(c.dim('  launching claude...\n'));
      require('child_process').spawn('claude', [], { stdio: 'inherit', cwd: process.cwd() })
        .on('error', () => console.log(c.y('  could not launch `claude` — start it yourself')));
    } else {
      console.log(`\n  Now run:  ${c.b('claude')}`);
      console.log(c.dim('  (or: switchboard sbs --run  to pick and launch in one step)'));
    }
  }
}

// ---- sessions (the index) --------------------------------------------------

// The terminal equivalent of bare /sbs: every session, live and ended.
function sessions() {
  const store = new Store(W.storePath(workspace));
  if (!store.ok) return console.log(c.r('store unavailable — run `switchboard init` first'));
  C.sweep(store, workspace);
  console.log(C.sessionIndex(store, workspace, null, { maxTokens: 8000, all: has('all') }).body);
  store.close();
}

// ---- attach ----------------------------------------------------------------

// "Open a new terminal, pick a session, continue its work here."
// Queues a one-shot request that the NEXT session started in this workspace
// consumes at SessionStart.
function attach() {
  const store = new Store(W.storePath(workspace));
  if (!store.ok) return console.log(c.r('store unavailable — run `switchboard init` first'));
  C.sweep(store, workspace);

  const named = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;

  if (has('cancel')) {
    store.cancelAttach(workspace);
    console.log(`${c.g('✓')} pending attach cancelled`);
    return store.close();
  }

  const candidates = store.attachCandidates(workspace, null, W.DEFAULTS.liveTtlMs);
  if (!candidates.length) {
    console.log(c.y('No sessions found in this workspace yet.'));
    console.log(c.dim('Start a session here first, then attach from another terminal.'));
    return store.close();
  }

  if (named) return finish(C.findTarget(store, workspace, named, null));
  if (has('list')) { print(candidates); return store.close(); }

  // Interactive picker.
  print(candidates);
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.question(c.b('\nAttach to which session? '), ans => {
    rl.close();
    const n = Number(String(ans).trim());
    const pick = Number.isInteger(n) && n >= 1 && n <= candidates.length
      ? candidates[n - 1]
      : C.findTarget(store, workspace, String(ans).trim(), null);
    finish(pick);
  });

  function print(list) {
    console.log(`${c.b('switchboard')} ${c.dim(workspace)}\n`);
    console.log(c.dim('Sessions you can continue:\n'));
    list.forEach((s, i) => {
      const nm = s.name || s.session_id.slice(0, 8);
      const st = s.live ? c.g('live') : c.dim('ended');
      const d = store.getDigest(s.session_id);
      const cl = store.claimsFor(s.session_id);
      console.log(`  ${c.b(String(i + 1).padStart(2))}. ${c.b(pad(nm, 24))} ${c.c(pad(`[${W.agentLabel(s.agent)}]`, 15))} ${st}  ${c.dim(D.ago(Date.now() - s.last_seen))}`);
      if (s.intent || d?.intent) console.log(`      ${D.truncate(s.intent || d.intent, 74)}`);
      if (cl.length) console.log(`      ${c.dim(`${cl.length} file(s): ${cl.slice(0, 3).map(x => D.relTo(workspace, x.path)).join(', ')}`)}`);
    });
  }

  function finish(target) {
    if (!target) {
      console.log(c.y(`\nNo matching session${named ? ` for "${named}"` : ''}.`));
      return store.close();
    }
    const nm = target.name || target.session_id.slice(0, 8);
    // Adopting a live session's files would cause the very collision this
    // product exists to prevent, so it is only offered for ended sessions.
    const adopt = has('adopt') && !target.live;
    store.queueAttach({
      workspace, target_id: target.session_id, target_name: nm,
      ttlMs: 15 * 60_000, adopt: adopt ? 1 : 0,
    });
    console.log(`\n${c.g('✓')} queued: the next session started here will continue ${c.b(`"${nm}"`)}`);
    if (adopt) console.log(c.dim(`  its ${store.claimsFor(target.session_id).length} claimed file(s) will transfer to that session`));
    if (has('adopt') && target.live) console.log(c.y('  --adopt ignored: that session is still running'));
    console.log(c.dim(`\n  Now run:  claude          ${c.dim('(in this terminal)')}`));
    console.log(c.dim(`  Expires in 15 minutes · cancel with: switchboard attach --cancel`));
    store.close();
  }
}

// ---- ambient token budget --------------------------------------------------

function mode() {
  const want = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  if (want && !['full', 'lean', 'off'].includes(want)) {
    console.log(c.y(`Unknown mode "${want}". Use: full | lean | off`));
    return;
  }
  if (want) {
    C.ensureStoreDir(workspace);
    C.writeMode(workspace, want);
    console.log(`${c.g('✓')} ambient mode: ${c.b(want)}`);
  }
  const cur = C.readMode(workspace);
  console.log(`
  ${cur === 'full' ? c.g('▸') : ' '} ${c.b('full')}  ~150 tok/session   the roster: who is live, what they hold  ${c.dim('(default)')}
  ${cur === 'lean' ? c.g('▸') : ' '} ${c.b('lean')}   ~18 tok/session   one line; the model pulls only if it cares
  ${cur === 'off'  ? c.g('▸') : ' '} ${c.b('off')}      0 tok           nothing arrives uninvited

  ${c.dim('These control only what is injected AUTOMATICALLY.')}
  ${c.dim('sb_peers / @<name> / /sbs / switchboard sbs work the same in every mode.')}`);
}

// ---- statusline indicator --------------------------------------------------

function statusline() {
  const sl = I.statusLine({ local: !flags.has('--npx') });
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'status';

  if (sub === 'install') {
    const before = sl.current();
    const r = sl.apply();
    if (!r) { console.log(c.dim('already installed')); return; }
    console.log(`${c.g('✓')} status line indicator installed`);
    console.log(`  ${c.dim('settings:')} ${rel(sl.file)}`);
    if (before) console.log(`  ${c.dim('chained:')}  ${before}  ${c.dim('(runs first, output preserved)')}`);
    console.log(c.dim('\nRestart your session to see it. Shows [SWITCHBOARD] in this workspace.'));
    return;
  }
  if (sub === 'uninstall') {
    const chained = sl.chained();
    const r = sl.revert();
    console.log(r ? `${c.g('✓')} removed${chained ? `, restored: ${chained}` : ''}` : c.dim('not installed'));
    return;
  }
  // status
  console.log(`${c.b('status line')}`);
  console.log(`  installed: ${sl.installed() ? c.g('yes') : c.y('no')}`);
  console.log(`  current:   ${sl.current() || c.dim('(none)')}`);
  if (sl.chained()) console.log(`  chained:   ${sl.chained()}`);
  console.log(c.dim('\n  switchboard statusline install    # add [SWITCHBOARD] to your prompt'));
  console.log(c.dim('  switchboard statusline uninstall  # remove it, restore what was there'));
}

function help() {
  console.log(`
${c.b('switchboard')} ${c.dim(`v${pkg.version}`)} — ambient shared working memory for concurrent AI coding sessions

${c.b('Usage')}
  npx switchboard init [--dry-run] [--all] [--local]
  npx switchboard status [--json] [--raw]
  npx switchboard sbs [name] [--run] [--all]  # picker, or select by name
  npx switchboard sessions [--all]            # live sessions (--all adds ended)
  npx switchboard attach [name] [--list] [--adopt] [--cancel]
  npx switchboard board
  npx switchboard doctor
  npx switchboard statusline install|uninstall|status
  npx switchboard uninstall [--purge]
  npx switchboard purge

${c.b('Flags')}
  --dry-run   show the plan, write nothing
  --all       configure every supported agent, not just detected ones
  --local     point configs at this checkout instead of npx
  --run       sbs: launch claude immediately after picking
  --list      attach: show sessions without picking
  --adopt     attach: also take over its files (ended sessions only)
  --cancel    attach: clear a queued attach
  --json      machine-readable status
  --raw       dump everything stored (inspect before you trust it)

${c.dim('Docs: switchboard-prd.md · switchboard-compatibility-report.md')}
`);
}

function rel(p) { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; }
function pad(s, n) { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); }

main();
