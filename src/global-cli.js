'use strict';
const fs = require('node:fs');
const G = require('./global-installers');
const W = require('./workspace');
const C = require('./core');
const { Store } = require('./store');

function run({ command, dryRun = false, json = false, purge = false, opts = {} }) {
  if (purge) throw new Error('Global uninstall keeps saved context. Use switchboard purge outside a repository to remove local terminal history.');
  if (command === 'init') {
    const items = G.plan(opts);
    console.log('Switchboard — setup for Claude and Codex in local terminals\n');
    for (const item of items) console.log(`  ${item.action === 'ok' ? 'already set' : 'write'}  ${item.label}: ${item.file}`);
    if (dryRun) { console.log('\nDry run: nothing written.'); return; }
    const result = G.apply(opts);
    console.log(`\nConfigured ${result.written.length} setting(s). Restart Claude and Codex to load Switchboard.`);
    console.log('Outside Git repositories, your terminals share one local group, even in different folders.');
    console.log('Ask either agent: "Show my other Switchboard sessions and connect to one."');
    console.log('Inside Git repositories, sessions stay grouped by repository.');
    return;
  }
  if (command === 'uninstall') {
    const result = G.revert(opts);
    console.log(`Restored ${result.removed.length} managed setting(s). Saved session history was kept.`);
    if (result.skipped.length) console.log(`Left ${result.skipped.length} changed setting(s) untouched; they differ from what Switchboard installed.`);
    console.log('Restart Claude and Codex to unload the global integration.');
    return;
  }
  if (command === 'doctor') {
    let problems = 0;
    for (const item of G.plan(opts)) {
      console.log(`${item.action === 'ok' ? 'OK' : 'MISSING'}  ${item.label}: ${item.file}`);
      if (item.action !== 'ok') problems++;
    }
    console.log(problems ? `Run switchboard init --global to repair ${problems} setting(s).` : 'Global setup is ready. Restart agents after configuration changes.');
    if (problems) process.exitCode = 1;
    return;
  }
  if (['status', 'sessions', 'ls'].includes(command)) {
    const workspace = G.paths(opts).workspace;
    if (!fs.existsSync(W.storePath(workspace))) {
      console.log(json ? JSON.stringify({ workspace, peers: [] }) : 'No local terminal sessions recorded yet. Start Claude or Codex outside a Git repository.');
      return;
    }
    const store = new Store(W.storePath(workspace));
    try {
      if (!store.ok) throw store.error;
      C.sweep(store, workspace);
      const ctx = C.rosterContext(store, workspace, null);
      if (json) { console.log(JSON.stringify(ctx, null, 2)); return; }
      console.log('Switchboard local terminals\n');
      if (!ctx.peers.length) console.log('No live local terminal sessions.');
      for (const s of ctx.peers) {
        console.log(`${s.name || s.session_id} [${W.agentLabel(s.agent)}]\n  Directory: ${s.cwd}\n  ${s.intent || 'Waiting for a task'}`);
      }
    } finally { store.close(); }
    return;
  }
  throw new Error(`--global supports init, doctor, status, sessions, and uninstall. To connect running terminals, ask the agent to use sb_peers and sb_attach.`);
}

module.exports = { run };
