'use strict';
// Arrow-key session picker.
//
// This runs in the TERMINAL, not inside an agent session, and that is the
// whole point: browsing costs ZERO tokens. The model never sees the list, only
// the one session you choose. A slash command that asked the model to print
// the sessions would burn context on every row you scrolled past.
//
// Raw-mode keypresses via node:readline. No dependencies, no curses.

const readline = require('node:readline');
const W = require('./workspace');
const D = require('./digest');

const ESC = '\x1b';
const c = {
  reset: `${ESC}[0m`, bold: `${ESC}[1m`, dim: `${ESC}[2m`,
  green: `${ESC}[32m`, yellow: `${ESC}[33m`, cyan: `${ESC}[36m`,
  inv: `${ESC}[7m`,
};

function plain(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

// One row, rendered for the list. `sel` draws the highlight bar.
function row(s, ctx, sel, width) {
  const name = (s.name || s.session_id.slice(0, 8)).padEnd(32).slice(0, 32);
  const agent = `[${W.agentLabel(s.agent)}]`.padEnd(14).slice(0, 14);
  const state = s.live ? `${c.green}live ${c.reset}` : `${c.dim}ended${c.reset}`;
  const age = D.fmtAge(Date.now() - s.last_seen).padStart(5);

  const head = ` ${c.bold}${name}${c.reset} ${c.cyan}${agent}${c.reset} ${state} ${c.dim}${age}${c.reset}`;
  const lines = [sel ? `${c.inv}${plain(head).padEnd(width - 1)}${c.reset}` : head];

  const d = ctx.digestBySession?.[s.session_id];
  const claims = ctx.claimsBySession?.[s.session_id] || [];
  const intent = D.describe(s, d);
  if (intent) lines.push(`       ${c.dim}${D.truncate(D.collapse(intent), width - 12)}${c.reset}`);
  const files = claims.length ? claims.map(x => D.relTo(ctx.workspace, x.path)) : (d?.files || []).slice(-3);
  if (files.length) lines.push(`       ${c.dim}${D.truncate(files.join(', '), width - 12)}${c.reset}`);
  return lines;
}

function draw(sessions, ctx, cursor, out, width) {
  const live = sessions.filter(s => s.live).length;
  const body = [
    '',
    `  ${c.bold}switchboard${c.reset} ${c.dim}${ctx.workspace}${c.reset}`,
    `  ${c.dim}${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${live} live · ${sessions.length - live} ended${c.reset}`,
    '',
  ];
  sessions.forEach((s, i) => { body.push(...row(s, ctx, i === cursor, width)); body.push(''); });
  body.push(`  ${c.dim}↑/↓ move · ${c.reset}${c.bold}enter${c.reset}${c.dim} select · q or esc cancel${c.reset}`);
  out.write(`${ESC}[2J${ESC}[H${body.join('\n')}\n`);
}

// Resolves to the chosen session, or null if cancelled.
// Falls back to a plain numbered prompt when stdin is not a TTY (piped input,
// CI), so the picker is never a hard requirement.
function pick(sessions, ctx, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise(resolve => {
    if (!sessions.length) return resolve(null);
    if (!input.isTTY || !input.setRawMode) return resolve(pickFallback(sessions, ctx, input, output));

    const width = Math.max(60, Math.min(output.columns || 100, 120));
    let cursor = 0;
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    draw(sessions, ctx, cursor, output, width);

    const done = value => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('keypress', onKey);
      output.write(`${ESC}[2J${ESC}[H`);
      resolve(value);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + sessions.length) % sessions.length;
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % sessions.length;
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = sessions.length - 1;
      else if (key.name === 'return' || key.name === 'enter') return done(sessions[cursor]);
      else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) return done(null);
      else if (/^[1-9]$/.test(key.name || '')) {           // type a number to jump
        const n = Number(key.name) - 1;
        if (n < sessions.length) { cursor = n; draw(sessions, ctx, cursor, output, width); }
        return;
      } else return;
      draw(sessions, ctx, cursor, output, width);
    };

    input.on('keypress', onKey);
  });
}

// No raw-mode TTY (piped stdin, a wrapper terminal, CI). Arrow keys are
// impossible here, but selection must still be possible — printing a list and
// then giving up is a dead end. So: numbered list, read one line.
function pickFallback(sessions, ctx, input, output) {
  return new Promise(resolve => {
    output.write(`\n  ${c.bold}switchboard${c.reset} ${c.dim}${ctx.workspace}${c.reset}\n\n`);
    sessions.forEach((s, i) => {
      const name = s.name || s.session_id.slice(0, 8);
      const state = s.live ? `${c.green}live${c.reset}` : `${c.dim}ended${c.reset}`;
      output.write(`  ${c.bold}${String(i + 1).padStart(2)}${c.reset}. ${c.bold}${name}${c.reset} ${c.cyan}[${W.agentLabel(s.agent)}]${c.reset} ${state} ${c.dim}${D.fmtAge(Date.now() - s.last_seen)}${c.reset}\n`);
      const desc = D.describe(s, ctx.digestBySession?.[s.session_id]);
      if (desc) output.write(`      ${c.dim}${D.truncate(D.collapse(desc), 78)}${c.reset}\n`);
    });

    const rl = readline.createInterface({ input, output, terminal: false });
    let answered = false;
    const finish = v => { if (answered) return; answered = true; try { rl.close(); } catch { /* ignore */ } resolve(v); };

    output.write(`\n  ${c.bold}Select 1-${sessions.length}${c.reset} ${c.dim}(or a name, or blank to cancel):${c.reset} `);
    rl.on('line', line => {
      const ans = String(line).trim();
      if (!ans) return finish(null);
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return finish(sessions[n - 1]);
      const want = ans.toLowerCase().replace(/^[/@]/, '');
      const hit = sessions.find(s => (s.name || '').toLowerCase() === want)
        || sessions.find(s => (s.name || '').toLowerCase().startsWith(want))
        || sessions.find(s => s.session_id.toLowerCase().startsWith(want));
      if (hit) return finish(hit);
      output.write(`  ${c.yellow}no match for "${ans}"${c.reset}\n  Select 1-${sessions.length}: `);
    });
    // stdin closed with nothing typed: say how to select instead of vanishing.
    rl.on('close', () => {
      if (answered) return;
      output.write(`\n  ${c.dim}Nothing selected. Select directly with:${c.reset}\n` +
                   `    switchboard sbs 1\n` +
                   `    switchboard sbs ${sessions[0].name}\n`);
      finish(null);
    });
  });
}

// ---- advanced: cross-repo nested picker ------------------------------------
//
// Same zero-token argument as `pick`, one level deeper: repos are headings,
// their live sessions nest underneath, and only sessions are selectable —
// a repo on its own is not something you can hold a conversation with.

// Flatten the repo tree into display rows once, so navigation is a simple
// index walk that skips headings rather than a tree traversal.
function flatten(repos) {
  const rows = [];
  for (const r of repos) {
    rows.push({ type: 'repo', repo: r });
    for (const s of r.sessions) rows.push({ type: 'session', repo: r, session: s });
  }
  return rows;
}

function nestedRow(row, sel, width) {
  if (row.type === 'repo') {
    const n = row.repo.sessions.length;
    const base = require('node:path').basename(row.repo.workspace);
    return [`  ${c.bold}${base}${c.reset} ${c.dim}${row.repo.workspace}${c.reset}` +
            ` ${c.dim}(${n} session${n === 1 ? '' : 's'})${c.reset}`];
  }
  const s = row.session;
  const name = (s.name || s.session_id.slice(0, 8)).padEnd(30).slice(0, 30);
  const agent = `[${W.agentLabel(s.agent)}]`.padEnd(14).slice(0, 14);
  const age = D.fmtAge(Date.now() - s.last_seen).padStart(5);
  const line = `      ${c.bold}${name}${c.reset} ${c.cyan}${agent}${c.reset} ${c.green}live${c.reset} ${c.dim}${age}${c.reset}`;
  return [sel ? `${c.inv}${plain(line).padEnd(width - 1)}${c.reset}` : line];
}

function drawNested(rows, cursor, out, width, repos) {
  const total = rows.filter(r => r.type === 'session').length;
  const body = [
    '',
    `  ${c.bold}switchboard${c.reset} ${c.dim}advanced — connect across repos${c.reset}`,
    `  ${c.dim}${repos.length} repo${repos.length === 1 ? '' : 's'} open · ${total} live session${total === 1 ? '' : 's'}${c.reset}`,
    '',
  ];
  rows.forEach((r, i) => {
    body.push(...nestedRow(r, i === cursor, width));
    if (r.type === 'repo') return;
    body.push('');
  });
  body.push(`  ${c.dim}↑/↓ move · ${c.reset}${c.bold}enter${c.reset}${c.dim} connect · q or esc cancel${c.reset}`);
  out.write(`${ESC}[2J${ESC}[H${body.join('\n')}\n`);
}

// Resolves to {repo, session} or null.
function pickNested(repos, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise(resolve => {
    const rows = flatten(repos);
    const selectable = rows.map((r, i) => (r.type === 'session' ? i : -1)).filter(i => i >= 0);
    if (!selectable.length) return resolve(null);
    if (!input.isTTY || !input.setRawMode) return resolve(pickNestedFallback(rows, selectable, input, output));

    const width = Math.max(60, Math.min(output.columns || 100, 120));
    let at = 0;                                  // index into `selectable`
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    drawNested(rows, selectable[at], output, width, repos);

    const done = value => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('keypress', onKey);
      output.write(`${ESC}[2J${ESC}[H`);
      resolve(value);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') at = (at - 1 + selectable.length) % selectable.length;
      else if (key.name === 'down' || key.name === 'j') at = (at + 1) % selectable.length;
      else if (key.name === 'home') at = 0;
      else if (key.name === 'end') at = selectable.length - 1;
      else if (key.name === 'return' || key.name === 'enter') {
        const row = rows[selectable[at]];
        return done({ repo: row.repo, session: row.session });
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) return done(null);
      else return;
      drawNested(rows, selectable[at], output, width, repos);
    };

    input.on('keypress', onKey);
  });
}

function pickNestedFallback(rows, selectable, input, output) {
  return new Promise(resolve => {
    output.write(`\n  ${c.bold}switchboard advanced${c.reset} ${c.dim}— connect across repos${c.reset}\n\n`);
    let n = 0;
    const numbered = [];
    for (const row of rows) {
      if (row.type === 'repo') {
        output.write(`  ${c.bold}${require('node:path').basename(row.repo.workspace)}${c.reset} ${c.dim}${row.repo.workspace}${c.reset}\n`);
        continue;
      }
      n += 1;
      numbered.push(row);
      const s = row.session;
      output.write(`    ${c.bold}${String(n).padStart(2)}${c.reset}. ${s.name || s.session_id.slice(0, 8)} ` +
                   `${c.cyan}[${W.agentLabel(s.agent)}]${c.reset} ${c.dim}${D.fmtAge(Date.now() - s.last_seen)}${c.reset}\n`);
    }

    const rl = readline.createInterface({ input, output, terminal: false });
    let answered = false;
    const finish = v => { if (answered) return; answered = true; try { rl.close(); } catch { /* ignore */ } resolve(v); };
    output.write(`\n  ${c.bold}Select 1-${n}${c.reset} ${c.dim}(or a name, blank to cancel):${c.reset} `);
    rl.on('line', line => {
      const ans = String(line).trim();
      if (!ans) return finish(null);
      const i = Number(ans);
      if (Number.isInteger(i) && i >= 1 && i <= numbered.length) {
        const row = numbered[i - 1];
        return finish({ repo: row.repo, session: row.session });
      }
      const want = ans.toLowerCase().replace(/^@/, '');
      const hit = numbered.find(r => (r.session.name || '').toLowerCase() === want)
        || numbered.find(r => (r.session.name || '').toLowerCase().startsWith(want));
      if (hit) return finish({ repo: hit.repo, session: hit.session });
      output.write(`  ${c.yellow}no match for "${ans}"${c.reset}\n  Select 1-${n}: `);
    });
    rl.on('close', () => finish(null));
  });
}

module.exports = { pick, pickNested, flatten };
