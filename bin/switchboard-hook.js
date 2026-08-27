#!/usr/bin/env node
'use strict';
// T3 hook entry point. Reads the agent's JSON payload on stdin.
//
// ADR-8 / Principle 7: this process ALWAYS exits 0, whatever happens. A
// context-sharing tool must never be the reason a session fails to start.

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const agent = arg('agent', 'claude-code');
const event = arg('event', null);

// §10.7 budgets: yield rather than block a session start.
const BUDGET_MS = Number(arg('timeout', 5000));
const guard = setTimeout(() => process.exit(0), BUDGET_MS);
guard.unref?.();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try { require('../src/hook').run({ input, agent, event }); }
  catch { /* fail open */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// No stdin at all (misconfigured hook): don't hang the agent.
setTimeout(() => { if (!input) process.exit(0); }, 250).unref?.();
