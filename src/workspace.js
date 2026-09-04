'use strict';
// Workspace identity, liveness sources, and the platform adapter.
//
// RISK-1: ~/.claude/sessions/*.json and ~/.claude/ide/*.lock are UNDOCUMENTED
// internals. Every read of them is confined to this file so drift has exactly
// one blast radius, and every one of them is optional — Switchboard works at
// full T1 with none of it available.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

const DEFAULTS = {
  liveTtlMs:      120_000,   // FR-2.2 — fallback only, when we have no pid
  staleMs:        12 * 3600_000, // pid alive but untouched this long => treat as gone
  claimTtlMs:     900_000,   // 15 min — §17 open question 3
  maxDigestTokens:      500, // FR-3.2 hard cap
  maxPeerTokens:         80, // §10.10
  maxWarnTokens:         60,
  maxSessionDigestTokens: 2000, // FR-6.3
};

// ---- workspace resolution (ADR-7) -----------------------------------------

// cwd → IDE lock workspaceFolders → git root. Resolve in that order; the
// first that produces a stable root wins.
function resolveWorkspace(cwd) {
  const abs = path.resolve(cwd || process.cwd());
  const viaIde = ideWorkspaceFor(abs);
  if (viaIde) return viaIde;
  const viaGit = gitRoot(abs);
  if (viaGit) return viaGit;
  return abs;
}

function ideWorkspaceFor(cwd) {
  try {
    const dir = path.join(CLAUDE_DIR, 'ide');
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.lock')) continue;
      const lock = readJson(path.join(dir, f));
      const folders = lock?.workspaceFolders;
      if (!Array.isArray(folders)) continue;
      // Longest containing folder wins, so nested projects resolve tightly.
      const hits = folders
        .filter(w => typeof w === 'string' && isWithin(cwd, w))
        .sort((a, b) => b.length - a.length);
      if (hits.length) return path.resolve(hits[0]);
    }
  } catch { /* optional source */ }
  return null;
}

// Walk up for .git rather than spawning `git`. A subprocess inside a hook with
// a 500ms budget is a latency risk we do not need to take, and this also works
// when git isn't on PATH. A .git *file* (linked worktree) is found too.
function gitRoot(cwd) {
  try {
    let dir = path.resolve(cwd);
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch { return null; }
}

function isWithin(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---- store location --------------------------------------------------------

function storeDir(workspace) { return path.join(workspace, '.switchboard'); }
function storePath(workspace) { return path.join(storeDir(workspace), 'state.db'); }
function rosterPath(workspace) { return path.join(storeDir(workspace), 'ROSTER.md'); }

// ---- Claude Code session registry (optional, RISK-1) ----------------------

// Maps a Claude Code process id to its real session id and name so the MCP
// server and the hooks converge on ONE identity instead of two rows.
function claudeSessionByPid(pid) {
  if (!pid) return null;
  const p = path.join(CLAUDE_DIR, 'sessions', `${pid}.json`);
  const j = readJson(p);
  if (!j || !j.sessionId) return null;
  return {
    session_id: j.sessionId, name: j.name, cwd: j.cwd, pid: j.pid,
    version: j.version, status: j.status, kind: j.kind,
  };
}

function claudeSessionsInWorkspace(workspace) {
  const out = [];
  try {
    const dir = path.join(CLAUDE_DIR, 'sessions');
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const j = readJson(path.join(dir, f));
      if (!j?.sessionId || !j.cwd) continue;
      if (resolveWorkspace(j.cwd) !== workspace) continue;
      out.push(j);
    }
  } catch { /* optional source */ }
  return out;
}

// ---- process ancestry ------------------------------------------------------

// The MCP server is spawned BY the agent (ADR-0), so our parent is the agent
// process. That parent pid is both our liveness signal and our link key.
function agentPid() {
  const pp = process.ppid;
  return Number.isInteger(pp) && pp > 1 ? pp : null;
}

function linkKey(cwd, pid) { return `${path.resolve(cwd)}|${pid ?? 0}`; }

// ---- agent identification --------------------------------------------------

// Normalise the many spellings of clientInfo.name into one stable slug.
function normalizeAgent(clientName) {
  const n = String(clientName || '').toLowerCase();
  if (!n) return 'unknown';
  if (n.includes('claude') && n.includes('code')) return 'claude-code';
  if (n.includes('claude')) return 'claude-code';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('windsurf') || n.includes('codeium')) return 'windsurf';
  if (n.includes('codex')) return 'codex';
  if (n.includes('gemini')) return 'gemini-cli';
  if (n.includes('copilot') || n.includes('vscode') || n.includes('visual studio code')) return 'copilot';
  if (n.includes('cline')) return 'cline';
  if (n.includes('roo')) return 'roo';
  if (n.includes('kilo')) return 'kilo';
  if (n.includes('continue')) return 'continue';
  if (n.includes('zed')) return 'zed';
  if (n.includes('goose')) return 'goose';
  if (n.includes('qwen')) return 'qwen';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('amazon') || n.includes('kiro')) return 'amazon-q';
  if (n.includes('aider')) return 'aider';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

// §3 of the compatibility report. `hooks: true` means T3 is reachable.
const AGENTS = {
  'claude-code': { label: 'Claude Code', hooks: true  },
  'cursor':      { label: 'Cursor',      hooks: true  },
  'gemini-cli':  { label: 'Gemini CLI',  hooks: true  },
  'opencode':    { label: 'OpenCode',    hooks: false },
  'windsurf':    { label: 'Windsurf',    hooks: false },
  'codex':       { label: 'Codex CLI',   hooks: false },
  'copilot':     { label: 'Copilot',     hooks: false },
  'cline':       { label: 'Cline',       hooks: false },
  'roo':         { label: 'Roo Code',    hooks: false },
  'kilo':        { label: 'Kilo Code',   hooks: false },
  'continue':    { label: 'Continue',    hooks: false },
  'zed':         { label: 'Zed',         hooks: false },
  'goose':       { label: 'Goose',       hooks: false },
  'qwen':        { label: 'Qwen Code',   hooks: false },
  'amazon-q':    { label: 'Amazon Q',    hooks: false },
  'aider':       { label: 'Aider',       hooks: false },
  'unknown':     { label: 'Unknown',     hooks: false },
};

function agentLabel(slug) { return AGENTS[slug]?.label ?? slug ?? 'unknown'; }

// ---- misc ------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeFileAtomic(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, p);
}

// FR-1.7: never touch the user's tracked .gitignore.
function gitExclude(workspace, entry) {
  try {
    const p = path.join(workspace, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.dirname(p))) return false;
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (cur.split('\n').some(l => l.trim() === entry)) return false;
    fs.appendFileSync(p, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}${entry}\n`);
    return true;
  } catch { return false; }
}

module.exports = {
  DEFAULTS, HOME, CLAUDE_DIR, AGENTS,
  resolveWorkspace, gitRoot, isWithin, ideWorkspaceFor,
  storeDir, storePath, rosterPath,
  claudeSessionByPid, claudeSessionsInWorkspace,
  agentPid, linkKey, normalizeAgent, agentLabel,
  readJson, writeFileAtomic, gitExclude,
};
