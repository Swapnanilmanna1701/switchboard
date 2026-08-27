'use strict';
// §11.3 — the honest cost of cross-agent support.
//
// MCP is universal; MCP *configuration* is not. Eight agents, eight formats.
// There is no clever abstraction available here, so this file is deliberately
// dumb, explicit, and one function per target. Every writer is:
//   idempotent (FR-1.3) · diff-reporting (FR-1.4) · reversible (FR-1.6)
//   non-clobbering of the user's own keys (FR-1.2)
// A failure in one writer never aborts the others (RISK-9).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const W = require('./workspace');

const HOME = os.homedir();
const KEY = 'switchboard';
const MARK_BEGIN = '<!-- switchboard:begin -->';
const MARK_END = '<!-- switchboard:end -->';

// How agents should launch us. `npx -y switchboard-mcp` works before a global
// install exists, which is the whole point of an npx-first product.
function serverSpec(opts = {}) {
  if (opts.local) {
    return { command: process.execPath, args: [path.join(__dirname, '..', 'bin', 'switchboard-mcp.js')] };
  }
  return { command: 'npx', args: ['-y', 'switchboard-mcp'] };
}

function hookCommand(agent, event, opts = {}) {
  const bin = opts.local
    ? `${quote(process.execPath)} ${quote(path.join(__dirname, '..', 'bin', 'switchboard-hook.js'))}`
    : 'npx -y switchboard-hook';
  return `${bin} --agent ${agent} --event ${event}`;
}

function quote(s) { return /[\s"']/.test(s) ? `"${s}"` : s; }

// ---- small JSON helpers ----------------------------------------------------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

// ---- MCP config writers ----------------------------------------------------

// Shape A: { mcpServers: { switchboard: {command,args} } }
// Used by Claude Code, Cursor, Windsurf, Gemini CLI, Cline, Roo, Kilo.
function mcpShapeA(file, opts) {
  return {
    detect: () => fs.existsSync(file) || fs.existsSync(path.dirname(file)),
    installed: () => !!readJson(file)?.mcpServers?.[KEY],
    apply: () => {
      const cur = readJson(file) || {};
      cur.mcpServers = cur.mcpServers || {};
      cur.mcpServers[KEY] = serverSpec(opts);
      writeJson(file, cur);
      return file;
    },
    revert: () => {
      const cur = readJson(file);
      if (!cur?.mcpServers?.[KEY]) return null;
      delete cur.mcpServers[KEY];
      if (Object.keys(cur.mcpServers).length === 0) delete cur.mcpServers;
      writeJson(file, cur);
      return file;
    },
  };
}

// Shape B: { servers: { switchboard: {...} } } — VS Code / Copilot.
function mcpShapeB(file, opts) {
  return {
    detect: () => fs.existsSync(path.dirname(file)),
    installed: () => !!readJson(file)?.servers?.[KEY],
    apply: () => {
      const cur = readJson(file) || {};
      cur.servers = cur.servers || {};
      cur.servers[KEY] = { type: 'stdio', ...serverSpec(opts) };
      writeJson(file, cur);
      return file;
    },
    revert: () => {
      const cur = readJson(file);
      if (!cur?.servers?.[KEY]) return null;
      delete cur.servers[KEY];
      writeJson(file, cur);
      return file;
    },
  };
}

// Shape C: { context_servers: { switchboard: {...} } } — Zed.
function mcpShapeC(file, opts) {
  return {
    // Consistent with the other shapes: the agent's config DIRECTORY existing
    // is what says "this agent is installed". Its settings file may not exist
    // yet on a fresh install.
    detect: () => fs.existsSync(file) || fs.existsSync(path.dirname(file)),
    installed: () => !!readJson(file)?.context_servers?.[KEY],
    apply: () => {
      const cur = readJson(file) || {};
      cur.context_servers = cur.context_servers || {};
      cur.context_servers[KEY] = { source: 'custom', ...serverSpec(opts) };
      writeJson(file, cur);
      return file;
    },
    revert: () => {
      const cur = readJson(file);
      if (!cur?.context_servers?.[KEY]) return null;
      delete cur.context_servers[KEY];
      writeJson(file, cur);
      return file;
    },
  };
}

// Shape D: TOML — Codex CLI, the only non-JSON target.
// ponytail: append/strip a whole named section rather than parsing TOML. A
// real TOML parser is a dependency, and we only ever own one section. If Codex
// ever needs nested edits, add @iarna/toml then and not before.
function mcpShapeD(file, opts) {
  const header = `[mcp_servers.${KEY}]`;
  const spec = serverSpec(opts);
  const block =
    `\n${header}\n` +
    `command = ${JSON.stringify(spec.command)}\n` +
    `args = [${spec.args.map(a => JSON.stringify(a)).join(', ')}]\n`;
  return {
    detect: () => fs.existsSync(file) || fs.existsSync(path.dirname(file)),
    installed: () => {
      try { return fs.readFileSync(file, 'utf8').includes(header); } catch { return false; }
    },
    apply: () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (cur.includes(header)) return file;
      fs.writeFileSync(file, cur + block);
      return file;
    },
    revert: () => {
      if (!fs.existsSync(file)) return null;
      const cur = fs.readFileSync(file, 'utf8');
      if (!cur.includes(header)) return null;
      // Line-based, not regex: a `[` also opens a TOML array, so "delete until
      // the next [" chops mid-value and orphans lines. A section ends at the
      // next line that is itself a section header.
      const isHeader = l => /^\s*\[[^\]]+\]\s*$/.test(l);
      const lines = cur.split('\n');
      const out = [];
      let skipping = false;
      for (const l of lines) {
        if (isHeader(l)) skipping = l.trim() === header;
        if (!skipping) out.push(l);
      }
      const body = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      // If we authored the whole file, leave nothing behind.
      if (body.trim() === '') { fs.rmSync(file, { force: true }); return file; }
      fs.writeFileSync(file, body);
      return file;
    },
  };
}

// ---- hook config writers ---------------------------------------------------

// Claude Code: .claude/settings.json → hooks.<Event>[].hooks[]
const CLAUDE_HOOKS = [
  ['SessionStart',     'startup|resume|clear'],
  ['UserPromptSubmit', null],
  ['PreToolUse',       'Edit|Write|NotebookEdit|MultiEdit'],
  ['PostToolUse',      'Edit|Write|NotebookEdit|MultiEdit|Bash|Read'],
  ['Stop',             null],
  ['PreCompact',       'auto|manual'],
  ['SessionEnd',       null],
];

function claudeHooks(file, opts) {
  const isOurs = h => typeof h?.command === 'string' && h.command.includes('switchboard-hook');
  return {
    detect: () => fs.existsSync(path.dirname(file)),
    installed: () => {
      const cur = readJson(file);
      return !!cur?.hooks?.SessionStart?.some(g => (g.hooks || []).some(isOurs));
    },
    apply: () => {
      const cur = readJson(file) || {};
      cur.hooks = cur.hooks || {};
      for (const [event, matcher] of CLAUDE_HOOKS) {
        cur.hooks[event] = (cur.hooks[event] || []).filter(g => !(g.hooks || []).some(isOurs));
        const group = { hooks: [{ type: 'command', command: hookCommand('claude-code', event, opts), timeout: 5 }] };
        if (matcher) group.matcher = matcher;
        cur.hooks[event].push(group);            // FR-1.2: user's own hooks kept
      }
      writeJson(file, cur);
      return file;
    },
    revert: () => {
      const cur = readJson(file);
      if (!cur?.hooks) return null;
      let changed = false;
      for (const event of Object.keys(cur.hooks)) {
        const before = cur.hooks[event].length;
        cur.hooks[event] = cur.hooks[event]
          .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
          .filter(g => (g.hooks || []).length > 0);
        if (cur.hooks[event].length !== before) changed = true;
        if (cur.hooks[event].length === 0) delete cur.hooks[event];
      }
      if (Object.keys(cur.hooks).length === 0) delete cur.hooks;
      if (!changed) return null;
      writeJson(file, cur);
      return file;
    },
  };
}

// Cursor: .cursor/hooks.json → { version: 1, hooks: { <event>: [ {command} ] } }
const CURSOR_HOOKS = ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'afterFileEdit', 'stop', 'sessionEnd'];

function cursorHooks(file, opts) {
  const isOurs = h => typeof h?.command === 'string' && h.command.includes('switchboard-hook');
  return {
    detect: () => fs.existsSync(path.dirname(file)),
    installed: () => {
      const cur = readJson(file);
      return !!cur?.hooks?.sessionStart?.some(isOurs);
    },
    apply: () => {
      const cur = readJson(file) || { version: 1 };
      cur.version = cur.version || 1;
      cur.hooks = cur.hooks || {};
      for (const ev of CURSOR_HOOKS) {
        cur.hooks[ev] = (cur.hooks[ev] || []).filter(h => !isOurs(h));
        cur.hooks[ev].push({ command: hookCommand('cursor', ev, opts) });
      }
      writeJson(file, cur);
      return file;
    },
    revert: () => {
      const cur = readJson(file);
      if (!cur?.hooks) return null;
      for (const ev of Object.keys(cur.hooks)) {
        cur.hooks[ev] = (cur.hooks[ev] || []).filter(h => !isOurs(h));
        if (!cur.hooks[ev].length) delete cur.hooks[ev];
      }
      writeJson(file, cur);
      return file;
    },
  };
}

// Gemini CLI: .gemini/settings.json → hooks.<Event>[].hooks[]
const GEMINI_HOOKS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'PreCompress', 'SessionEnd'];

function geminiHooks(file, opts) {
  const isOurs = h => typeof h?.command === 'string' && h.command.includes('switchboard-hook');
  return {
    detect: () => fs.existsSync(path.dirname(file)),
    installed: () => {
      const cur = readJson(file);
      return !!cur?.hooks?.SessionStart?.some(g => (g.hooks || []).some(isOurs));
    },
    apply: () => {
      const cur = readJson(file) || {};
      cur.hooks = cur.hooks || {};
      for (const ev of GEMINI_HOOKS) {
        cur.hooks[ev] = (cur.hooks[ev] || []).filter(g => !(g.hooks || []).some(isOurs));
        cur.hooks[ev].push({
          matcher: '*',
          hooks: [{ name: `switchboard-${ev}`, type: 'command', command: hookCommand('gemini-cli', ev, opts), timeout: 5000 }],
        });
      }
      writeJson(file, cur);
      return file;
    },
    revert: () => {
      const cur = readJson(file);
      if (!cur?.hooks) return null;
      for (const ev of Object.keys(cur.hooks)) {
        cur.hooks[ev] = (cur.hooks[ev] || [])
          .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
          .filter(g => (g.hooks || []).length > 0);
        if (!cur.hooks[ev].length) delete cur.hooks[ev];
      }
      if (!Object.keys(cur.hooks).length) delete cur.hooks;
      writeJson(file, cur);
      return file;
    },
  };
}

// ---- the registry ----------------------------------------------------------

// Is this agent actually installed on the machine / used in this repo?
//
// Detection must NOT be "does its config file already exist" — that was a real
// bug: in a fresh workspace `.claude/` does not exist yet, so the hook writer
// never fired and every agent silently degraded from T3 to T1. Presence is a
// property of the AGENT (its home dir, or a marker in this repo), not of the
// specific file we are about to write.
function agentPresent(agent, workspace, home = HOME) {
  const w = p => fs.existsSync(path.join(workspace, p));
  const h = p => fs.existsSync(path.join(home, p));
  switch (agent) {
    case 'claude-code': return h('.claude') || w('.claude') || w('CLAUDE.md') || w('.mcp.json');
    case 'cursor':      return h('.cursor') || w('.cursor');
    case 'gemini-cli':  return h('.gemini') || w('.gemini');
    case 'opencode':    return h('.config/opencode') || h('.opencode') || w('.opencode');
    case 'copilot':     return w('.vscode') || h('.vscode');
    case 'cline':       return w('.cline') || h('.cline');
    case 'codex':       return h('.codex');
    case 'windsurf':    return h('.codeium');
    case 'zed':         return h('.config/zed');
    default:            return false;
  }
}

// Ordered so the T3 agents appear first in `doctor` output.
//
// `scope` matters: a workspace-scoped config is ours to create, but a
// USER-scoped one lives in the agent's own home directory. We never create
// those speculatively — writing ~/.codex/config.toml for someone who has no
// Codex installed litters their home with config for software they don't run.
// User-scoped targets are written only when the agent is actually detected,
// even under --all.
function targets(workspace, opts = {}) {
  const home = opts.home || HOME;
  const w = p => path.join(workspace, p);
  const h = p => path.join(home, p);
  const T = (agent, label, kind, tier, scope, file, writer) =>
    ({ agent, label, kind, tier, scope, file, w: writer });
  return [
    T('claude-code', 'Claude Code', 'mcp',  3, 'workspace', w('.mcp.json'),             mcpShapeA(w('.mcp.json'), opts)),
    T('claude-code', 'Claude Code', 'hook', 3, 'workspace', w('.claude/settings.json'), claudeHooks(w('.claude/settings.json'), opts)),
    T('cursor',      'Cursor',      'mcp',  3, 'workspace', w('.cursor/mcp.json'),      mcpShapeA(w('.cursor/mcp.json'), opts)),
    T('cursor',      'Cursor',      'hook', 3, 'workspace', w('.cursor/hooks.json'),    cursorHooks(w('.cursor/hooks.json'), opts)),
    T('gemini-cli',  'Gemini CLI',  'mcp',  3, 'workspace', w('.gemini/settings.json'), mcpShapeA(w('.gemini/settings.json'), opts)),
    T('gemini-cli',  'Gemini CLI',  'hook', 3, 'workspace', w('.gemini/settings.json'), geminiHooks(w('.gemini/settings.json'), opts)),
    T('copilot',     'VS Code / Copilot', 'mcp', 1, 'workspace', w('.vscode/mcp.json'), mcpShapeB(w('.vscode/mcp.json'), opts)),
    T('cline',       'Cline',       'mcp',  1, 'workspace', w('.cline/mcp.json'),       mcpShapeA(w('.cline/mcp.json'), opts)),
    T('opencode',    'OpenCode',    'mcp',  1, 'workspace', w('.opencode/mcp.json'),    mcpShapeA(w('.opencode/mcp.json'), opts)),
    T('codex',       'Codex CLI',   'mcp',  1, 'user', h('.codex/config.toml'),                mcpShapeD(h('.codex/config.toml'), opts)),
    T('windsurf',    'Windsurf',    'mcp',  1, 'user', h('.codeium/windsurf/mcp_config.json'), mcpShapeA(h('.codeium/windsurf/mcp_config.json'), opts)),
    T('zed',         'Zed',         'mcp',  1, 'user', h('.config/zed/settings.json'),         mcpShapeC(h('.config/zed/settings.json'), opts)),
  ];
}

// ---- AGENTS.md (T0, ADR-0b) ------------------------------------------------

const STANZA_BODY = `## Concurrent sessions

Other AI sessions may be working in this repo right now.
Before starting a task, call \`sb_peers\` (MCP) — or read
\`.switchboard/ROSTER.md\` — to see what they're doing and which
files they've claimed. Post findings with \`sb_note\`.`;

const STANZA = `${MARK_BEGIN}\n${STANZA_BODY}\n${MARK_END}\n`;

// RISK-11: written ONCE, static, ~5 lines. All churn lives in the
// git-excluded ROSTER.md, so the repo never sees a diff from us.
function agentsMd(workspace) {
  const file = path.join(workspace, 'AGENTS.md');
  return {
    file,
    installed: () => {
      try { return fs.readFileSync(file, 'utf8').includes(MARK_BEGIN); } catch { return false; }
    },
    apply: () => {
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# AGENTS.md\n';
      if (cur.includes(MARK_BEGIN)) return null;
      fs.writeFileSync(file, `${cur.trimEnd()}\n\n${STANZA}`);
      return file;
    },
    revert: () => {
      if (!fs.existsSync(file)) return null;
      const cur = fs.readFileSync(file, 'utf8');
      if (!cur.includes(MARK_BEGIN)) return null;
      const out = cur.replace(new RegExp(`\\n*${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}\\n*`, 'g'), '\n');
      fs.writeFileSync(file, out.replace(/\n{3,}/g, '\n\n'));
      return file;
    },
  };
}

// §10.3 caveat: Claude Code reads CLAUDE.md, not AGENTS.md. Bridge with the
// @import Anthropic's own docs recommend.
function claudeBridge(workspace) {
  const file = path.join(workspace, 'CLAUDE.md');
  const agents = path.join(workspace, 'AGENTS.md');
  const line = '@AGENTS.md';

  // `ln -s AGENTS.md CLAUDE.md` is the OTHER bridge Anthropic documents, and
  // plenty of repos already use it. Writing "@AGENTS.md" into a CLAUDE.md that
  // *is* AGENTS.md makes the file import itself — so treat the symlink as the
  // bridge already being in place and do nothing.
  const symlinked = () => {
    try {
      if (!fs.existsSync(file) || !fs.existsSync(agents)) return false;
      return fs.realpathSync(file) === fs.realpathSync(agents);
    } catch { return false; }
  };

  return {
    file,
    symlinked,
    installed: () => {
      if (symlinked()) return true;                      // already bridged
      try { return fs.readFileSync(file, 'utf8').split('\n').some(l => l.trim() === line); } catch { return false; }
    },
    apply: () => {
      if (symlinked()) return null;
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (cur.split('\n').some(l => l.trim() === line)) return null;
      fs.writeFileSync(file, cur ? `${line}\n\n${cur.trimStart()}` : `${line}\n`);
      return file;
    },
    revert: () => {
      if (symlinked()) return null;          // we never wrote it; never unwrite it
      if (!fs.existsSync(file)) return null;
      const cur = fs.readFileSync(file, 'utf8');
      const lines = cur.split('\n');
      const i = lines.findIndex(l => l.trim() === line);
      if (i < 0) return null;
      lines.splice(i, 1);
      fs.writeFileSync(file, lines.join('\n').replace(/^\n+/, ''));
      return file;
    },
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---- status line indicator -------------------------------------------------

// Claude Code allows exactly ONE statusLine command. Ponytail (and others) may
// already own it, so we CHAIN: remember the existing command, install ours,
// and ours runs theirs first. Uninstall restores exactly what was there.
function statusLine(opts = {}) {
  const home = opts.home || HOME;
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const settings = path.join(dir, 'settings.json');
  const chainFile = path.join(dir, 'switchboard-statusline.json');
  const script = path.join(__dirname, '..', 'bin', 'switchboard-statusline.js');
  const ours = opts.local === false
    ? 'npx -y switchboard-statusline'
    : `${quote(process.execPath)} ${quote(script)}`;

  const isOurs = c => typeof c === 'string' && c.includes('switchboard-statusline');

  return {
    file: settings,
    command: ours,
    installed: () => isOurs(readJson(settings)?.statusLine?.command),
    current: () => readJson(settings)?.statusLine?.command || null,
    chained: () => readJson(chainFile)?.chain || null,

    apply: () => {
      const cur = readJson(settings) || {};
      const existing = cur.statusLine?.command;
      if (isOurs(existing)) return null;                       // idempotent
      fs.mkdirSync(dir, { recursive: true });
      // Preserve whatever was there so our script can run it first.
      fs.writeFileSync(chainFile, `${JSON.stringify({
        chain: existing || null,
        previous: cur.statusLine || null,
      }, null, 2)}\n`);
      cur.statusLine = { type: 'command', command: ours };
      writeJson(settings, cur);
      return settings;
    },

    revert: () => {
      const cur = readJson(settings);
      if (!cur || !isOurs(cur.statusLine?.command)) return null;
      const saved = readJson(chainFile);
      if (saved?.previous) cur.statusLine = saved.previous;    // exact restore
      else delete cur.statusLine;
      writeJson(settings, cur);
      fs.rmSync(chainFile, { force: true });
      return settings;
    },
  };
}

// ---- plan / apply / revert -------------------------------------------------

// FR-1.4: build the full plan first so --dry-run can print it without writing.
function plan(workspace, opts = {}) {
  const items = [];
  for (const t of targets(workspace, opts)) {
    let detected = false, installed = false, err = null;
    try {
      // Presence of the AGENT decides, not presence of the file we'd write.
      detected = agentPresent(t.agent, workspace, opts.home || HOME);
      installed = t.w.installed();
    } catch (e) { err = e.message; }
    // --all forces workspace-scoped targets only. A user-scoped config is
    // written solely when that agent is genuinely present on the machine.
    const eligible = installed || detected || (opts.all && t.scope === 'workspace');
    if (eligible) {
      items.push({ ...t, detected, installed, err, action: installed ? 'ok' : 'write' });
    }
  }
  const a = agentsMd(workspace);
  items.push({ agent: 'all', label: 'AGENTS.md stanza', kind: 'context', tier: 0, file: a.file,
    detected: true, installed: a.installed(), action: a.installed() ? 'ok' : 'write', w: a });
  const c = claudeBridge(workspace);
  items.push({ agent: 'claude-code', label: 'CLAUDE.md @AGENTS.md bridge', kind: 'context', tier: 0, file: c.file,
    detected: true, installed: c.installed(), action: c.installed() ? 'ok' : 'write', w: c });
  return items;
}

function apply(workspace, opts = {}) {
  const items = plan(workspace, opts);
  const written = [], failed = [];
  for (const it of items) {
    if (it.action !== 'write') continue;
    try {
      const f = it.w.apply();
      if (f) written.push({ ...it, written: f });
    } catch (e) {
      // RISK-9: one unwritable config never aborts the others.
      failed.push({ ...it, error: e.message });
    }
  }
  const dir = path.join(workspace, '.switchboard');
  fs.mkdirSync(dir, { recursive: true });
  W.gitExclude(workspace, '.switchboard/');
  const receipt = {
    version: require('../package.json').version,
    installedAt: new Date().toISOString(),
    workspace,
    wrote: written.map(x => ({ agent: x.agent, kind: x.kind, file: x.written })),
    failed: failed.map(x => ({ agent: x.agent, kind: x.kind, file: x.file, error: x.error })),
  };
  fs.writeFileSync(path.join(dir, 'install.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return { items, written, failed, receipt };
}

// FR-1.6: reverse everything init did, across every agent it touched.
function revert(workspace, opts = {}) {
  const removed = [], failed = [];
  const all = [
    ...targets(workspace, opts),
    { agent: 'all', label: 'AGENTS.md stanza', kind: 'context', w: agentsMd(workspace), file: path.join(workspace, 'AGENTS.md') },
    { agent: 'claude-code', label: 'CLAUDE.md bridge', kind: 'context', w: claudeBridge(workspace), file: path.join(workspace, 'CLAUDE.md') },
  ];
  for (const t of all) {
    try { const f = t.w.revert(); if (f) removed.push({ ...t, removed: f }); }
    catch (e) { failed.push({ ...t, error: e.message }); }
  }
  try { fs.rmSync(path.join(workspace, '.switchboard', 'install.json'), { force: true }); } catch { /* ignore */ }
  return { removed, failed };
}

module.exports = {
  targets, plan, apply, revert, agentsMd, claudeBridge, agentPresent, statusLine,
  serverSpec, hookCommand, STANZA, STANZA_BODY, MARK_BEGIN, MARK_END,
  CLAUDE_HOOKS, CURSOR_HOOKS, GEMINI_HOOKS,
};
