#!/usr/bin/env node
'use strict';
// Status line indicator: shows [SWITCHBOARD] while switchboard is active in the
// current workspace, mirroring how ponytail shows [PONYTAIL].
//
// Claude Code allows exactly ONE statusLine command, so this CHAINS: it runs
// whatever statusline was configured before, prints that output first, then
// appends its own tag. Clobbering another tool's indicator would be rude and
// would silently remove it.
//
// Contract (same as any statusline): JSON on stdin, one line on stdout,
// exit 0. Never throw, never hang — a broken statusline must not break the
// prompt.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CONFIG = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  'switchboard-statusline.json');

const COLOR = 111;          // light blue — distinct from ponytail's 108/173
const TIMEOUT_MS = 1500;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => { try { main(input); } catch { /* never break the prompt */ } process.exit(0); });
process.stdin.on('error', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));
setTimeout(() => process.exit(0), 3000).unref?.();

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* tolerate */ }
  const cwd = payload?.workspace?.current_dir || payload?.cwd || process.cwd();

  const parts = [];
  const chained = runChained(raw);
  if (chained) parts.push(chained);

  const tag = switchboardTag(cwd);
  if (tag) parts.push(tag);

  if (parts.length) process.stdout.write(parts.join(' '));
}

// Run the statusline that was configured before us, feeding it the same stdin.
function runChained(raw) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return ''; }
  const cmd = cfg?.chain;
  if (!cmd || typeof cmd !== 'string') return '';
  try {
    return execFileSync('/bin/sh', ['-c', cmd], {
      input: raw, encoding: 'utf8', timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).replace(/\n+$/, '');
  } catch { return ''; }         // a broken chain must not hide our own tag
}

// Active = switchboard is configured for this workspace. Shows the live peer
// count when there is one, mirroring ponytail's [PONYTAIL:MODE] shape.
function switchboardTag(cwd) {
  const ws = findWorkspace(cwd);
  if (!ws) return '';

  let peers = 0;
  try {
    const { Store } = require('../src/store');
    const W = require('../src/workspace');
    const store = new Store(W.storePath(ws));
    if (store.ok) {
      peers = store.livePeers(ws, null, W.DEFAULTS.liveTtlMs).length;
      store.close();
    }
  } catch { /* store optional — the tag still shows */ }

  const label = peers > 0 ? `[SWITCHBOARD:${peers}]` : '[SWITCHBOARD]';
  return `\x1b[38;5;${COLOR}m${label}\x1b[0m`;
}

// Walk up looking for a workspace switchboard is actually installed in.
// Presence of .switchboard/ or a switchboard entry in .mcp.json is the signal;
// we do not claim to be active in a repo where init was never run.
function findWorkspace(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.switchboard'))) return dir;
    try {
      const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
      if (mcp?.mcpServers?.switchboard) return dir;
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
