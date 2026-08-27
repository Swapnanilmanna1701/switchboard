#!/usr/bin/env node
'use strict';
// switchboard-adv — cross-repo connections.
//
// Run this in a PLAIN terminal, in the repo you are about to work in, BEFORE
// you start Claude Code / Cursor / whatever. It lists every repo that has a
// live session right now, nests those sessions underneath, and lets you pick
// one with the arrow keys. The next agent session you start in this repo opens
// already holding that session's context.
//
// Two properties this ordering buys, both deliberate:
//   - Crossing a repo boundary is always a human keystroke, never a config
//     file or a model deciding it would be useful.
//   - Browsing costs zero tokens. The model sees the one session you chose.

const path = require('node:path');
const W = require('../src/workspace');
const C = require('../src/core');
const R = require('../src/registry');
const P = require('../src/picker');
const D = require('../src/digest');

const ESC = '\x1b';
const c = {
  reset: `${ESC}[0m`, bold: `${ESC}[1m`, dim: `${ESC}[2m`,
  green: `${ESC}[32m`, yellow: `${ESC}[33m`, cyan: `${ESC}[36m`, red: `${ESC}[31m`,
};

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);

function usage() {
  console.log(`
${c.bold}switchboard-adv${c.reset} — connect this repo's next session to a session in another repo

${c.bold}Usage${c.reset}
  switchboard-adv              pick a session to connect to
  switchboard-adv --list       show open repos, pick nothing
  switchboard-adv --status     show the pending connection, if any
  switchboard-adv --clear      drop the pending connection, back to normal scope

Run this ${c.bold}before${c.reset} starting your agent. Normal scope stays repo-local and
live-only; this is the only way to reach across a repo boundary.
`);
}

function listRepos(repos, here) {
  if (!repos.length) {
    console.log(`\n  ${c.yellow}No repos have live sessions right now.${c.reset}`);
    console.log(`  ${c.dim}Start an agent session somewhere, then run this again.${c.reset}\n`);
    return;
  }
  console.log(`\n  ${c.bold}switchboard${c.reset} ${c.dim}advanced — connect across repos${c.reset}\n`);
  for (const r of repos) {
    const mine = r.workspace === here ? ` ${c.dim}(this repo)${c.reset}` : '';
    console.log(`  ${c.bold}${path.basename(r.workspace)}${c.reset} ${c.dim}${r.workspace}${c.reset}${mine}`);
    for (const s of r.sessions) {
      console.log(`      ${s.name || s.session_id.slice(0, 8)}  ${c.cyan}[${W.agentLabel(s.agent)}]${c.reset}` +
                  `  ${c.green}live${c.reset} ${c.dim}${D.fmtAge(Date.now() - s.last_seen)}${c.reset}`);
    }
  }
  console.log('');
}

async function main() {
  if (has('help') || has('h')) return usage();

  const workspace = W.resolveWorkspace(process.cwd());
  if (!workspace) {
    console.error(`  ${c.red}Not inside a repo.${c.reset} cd to the repo you are about to work in.`);
    process.exitCode = 1;
    return;
  }

  if (has('status')) {
    const link = C.readLink(workspace);
    if (!link) {
      console.log(`\n  ${c.dim}No pending connection. Scope:${c.reset} ${C.readScope(workspace)}\n`);
    } else {
      console.log(`\n  ${c.bold}Pending connection${c.reset}`);
      console.log(`    → ${link.name || link.session_id} ${c.dim}in ${link.workspace}${c.reset}`);
      console.log(`    ${c.dim}applies to the next session started here${c.reset}\n`);
    }
    return;
  }

  if (has('clear')) {
    C.consumeLink(workspace);
    C.writeScope(workspace, 'normal');
    console.log(`\n  ${c.green}✓${c.reset} connection cleared — back to normal scope (live, this repo only)\n`);
    return;
  }

  const repos = R.openRepos();
  if (has('list')) return listRepos(repos, workspace);

  if (!repos.length) {
    listRepos(repos, workspace);
    return;
  }

  const chosen = await P.pickNested(repos, {});
  if (!chosen) {
    console.log(`  ${c.dim}Nothing selected.${c.reset}`);
    return;
  }

  C.writeLink(workspace, {
    workspace: chosen.repo.workspace,
    session_id: chosen.session.session_id,
    name: chosen.session.name,
    agent: chosen.session.agent,
  });
  C.writeScope(workspace, 'advanced');

  const label = chosen.session.name || chosen.session.session_id.slice(0, 8);
  console.log(`\n  ${c.green}✓${c.reset} next session in ${c.bold}${path.basename(workspace)}${c.reset} will connect to`);
  console.log(`    ${c.bold}${label}${c.reset} ${c.dim}in ${chosen.repo.workspace}${c.reset}\n`);
  console.log(`  ${c.dim}Start your agent now. The connection applies once, then expires.${c.reset}`);
  console.log(`  ${c.dim}Undo with: switchboard-adv --clear${c.reset}\n`);
}

main().catch(err => {
  // Fail open, loudly. This is an interactive tool, so a silent failure here
  // would leave you believing a connection exists when it does not.
  console.error(`  ${c.red}switchboard-adv failed:${c.reset} ${err?.message ?? err}`);
  process.exitCode = 1;
});
