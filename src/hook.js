'use strict';
// T3 enhancement (§10.7): one hook implementation, four agent dialects.
//
// Claude Code, Cursor, Gemini CLI and OpenCode converged on near-identical
// lifecycles, so the only per-agent code is a name map and an output shape.
// Everything below the normaliser is shared.
//
// ADR-8 / Principle 7: this process exits 0 unconditionally. A hook that
// throws, times out, or finds a corrupt store injects nothing and succeeds.
// A context-sharing tool must never be why a session fails to start.

const path = require('node:path');
const W = require('./workspace');
const C = require('./core');
const D = require('./digest');

// Canonical events. Every dialect maps onto exactly these.
const EV = {
  SESSION_START: 'session-start',
  PRE_TOOL:      'pre-tool',
  POST_TOOL:     'post-tool',
  STOP:          'stop',
  PRE_COMPACT:   'pre-compact',
  SESSION_END:   'session-end',
  PROMPT:        'prompt',
};

// §10.7 mapping table, in code.
const DIALECTS = {
  'claude-code': {
    events: {
      SessionStart: EV.SESSION_START, PreToolUse: EV.PRE_TOOL, PostToolUse: EV.POST_TOOL,
      Stop: EV.STOP, PreCompact: EV.PRE_COMPACT, SessionEnd: EV.SESSION_END,
      UserPromptSubmit: EV.PROMPT,
    },
    read: r => ({
      session_id: r.session_id, cwd: r.cwd,
      tool_name: r.tool_name, tool_input: r.tool_input,
      last_message: r.last_assistant_message, prompt: r.user_input,
      hook_event_name: r.hook_event_name,
    }),
    // Verified against code.claude.com/docs/en/hooks.
    emit: (ev, ctxText) => ctxText
      ? { hookSpecificOutput: { hookEventName: ev, additionalContext: ctxText } }
      : null,
  },

  cursor: {
    events: {
      sessionStart: EV.SESSION_START, preToolUse: EV.PRE_TOOL, beforeReadFile: EV.PRE_TOOL,
      postToolUse: EV.POST_TOOL, afterFileEdit: EV.POST_TOOL, stop: EV.STOP,
      sessionEnd: EV.SESSION_END, beforeSubmitPrompt: EV.PROMPT,
    },
    read: r => ({
      session_id: r.conversation_id || r.session_id || r.generation_id,
      cwd: (Array.isArray(r.workspace_roots) ? r.workspace_roots[0] : null) || r.workspace_root || r.cwd,
      tool_name: r.tool_name || (r.file_path ? 'Edit' : null),
      tool_input: r.tool_input || (r.file_path ? { file_path: r.file_path } : null),
      last_message: r.last_message || r.text, prompt: r.prompt || r.text,
      hook_event_name: r.hook_event_name,
    }),
    // ⚪ Cursor's context-injection response shape is not vendor-documented for
    // every event. We emit the common `additionalContext` key AND print the
    // text on stdout, which most hook runners fold into context. Verify before
    // advertising T3 for Cursor (compatibility report §10, recommendation 3).
    emit: (_ev, ctxText) => ctxText ? { additionalContext: ctxText, continue: true } : null,
    alsoStdout: true,
  },

  'gemini-cli': {
    events: {
      SessionStart: EV.SESSION_START, BeforeTool: EV.PRE_TOOL, AfterTool: EV.POST_TOOL,
      AfterAgent: EV.STOP, PreCompress: EV.PRE_COMPACT, SessionEnd: EV.SESSION_END,
      BeforeAgent: EV.PROMPT, BeforeModel: EV.PROMPT,
    },
    read: r => ({
      session_id: r.session_id || r.sessionId,
      cwd: r.cwd || r.workspace_dir,
      tool_name: r.tool_name || r.toolName || r.tool?.name,
      tool_input: r.tool_input || r.toolArgs || r.tool?.args,
      last_message: r.last_message || r.response, prompt: r.prompt || r.user_input,
      hook_event_name: r.hook_event_name || r.event,
    }),
    // 🟡 Gemini CLI documents context injection on BeforeAgent/BeforeModel.
    emit: (_ev, ctxText) => ctxText ? { additionalContext: ctxText } : null,
    alsoStdout: true,
  },

  opencode: {
    events: {
      'session.start': EV.SESSION_START, 'tool.before': EV.PRE_TOOL, 'tool.after': EV.POST_TOOL,
      'session.idle': EV.STOP, 'session.end': EV.SESSION_END, 'chat.message': EV.PROMPT,
    },
    read: r => ({
      session_id: r.sessionID || r.session_id, cwd: r.directory || r.cwd,
      tool_name: r.tool || r.tool_name, tool_input: r.args || r.tool_input,
      last_message: r.message, prompt: r.prompt,
      hook_event_name: r.event || r.type,
    }),
    emit: (_ev, ctxText) => ctxText ? { additionalContext: ctxText } : null,
    alsoStdout: true,
  },
};

// Tools whose use means "this session is editing this file".
const EDIT_TOOLS = /^(Edit|Write|NotebookEdit|MultiEdit|str_replace_editor|edit_file|write_file|create_file|apply_patch)$/i;
const READ_TOOLS = /^(Read|read_file|view|open_file)$/i;
const SHELL_TOOLS = /^(Bash|Shell|run_terminal_cmd|execute_command|shell)$/i;

function filePathOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  return toolInput.file_path || toolInput.path || toolInput.filePath ||
         toolInput.target_file || toolInput.notebook_path || null;
}

function commandOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  return toolInput.command || toolInput.cmd || toolInput.script || null;
}

// ---- activity accumulation -------------------------------------------------

// FR-6.2: everything the digest needs is already in the hook payload, so this
// is pure mechanical extraction — no LLM call anywhere in the hot path.
function recordActivity(store, sessionId, workspace, { file, command, message, intent }) {
  const prev = store.getDigest(sessionId) || { files: [], commands: [] };
  const files = prev.files.slice();
  const commands = prev.commands.slice();
  if (file) { const r = D.relTo(workspace, file); if (!files.includes(r)) files.push(r); }
  if (command) { const c = D.truncate(D.collapse(command), 120); if (commands[commands.length - 1] !== c) commands.push(c); }
  store.putDigest(D.buildDigest({
    session_id: sessionId, workspace,
    intent: intent ?? prev.intent,
    files, commands,
    last_msg: message ?? prev.last_msg,
  }));
}

// ---- the handler -----------------------------------------------------------

function handle(raw, { agent = 'claude-code', eventOverride = null } = {}) {
  const dialect = DIALECTS[agent] || DIALECTS['claude-code'];
  const r = dialect.read(raw || {});
  const rawEvent = eventOverride || r.hook_event_name;
  const ev = dialect.events[rawEvent] || null;
  if (!ev) return { output: null, dialect };

  const cwd = r.cwd || process.cwd();
  const ctx = C.openContext(cwd);
  if (!ctx.ok) return { output: null, dialect };

  const store = ctx.store;
  const ws = ctx.workspace;
  const agentPid = W.agentPid();

  // Hooks carry the agent's own session id, which is authoritative. Fall back
  // to the pid-derived identity the MCP server uses so the two rows converge.
  const fallback = C.resolveIdentity({ agent, cwd, agent_pid: agentPid });
  const sessionId = r.session_id || fallback.session_id;
  const synthetic = r.session_id ? 0 : fallback.synthetic;

  let out = null;
  let notice = null;      // user-visible confirmation, shown by the agent

  try {
    switch (ev) {
      case EV.SESSION_START: {
        C.ensureStoreDir(ws);
        C.registerSession(store, {
          session_id: sessionId, cwd, workspace: ws, agent,
          name: nameFor(agent, sessionId, ws, agentPid),
          alias: nameFor(agent, sessionId, ws, agentPid),   // the agent's own name
          tier: 3,                       // hooks present ⇒ T3 (store max()'s it)
          synthetic,
          agent_pid: agentPid, status: 'active',
        });
        C.sweep(store, ws);

        // A cross-repo link set by `switchboard-adv` outranks everything else:
        // the user went to a terminal, browsed other repos and picked one
        // before starting this session. That is the most explicit intent we
        // will ever see. One-shot — consumeLink deletes it.
        const link = C.consumeLink(ws);
        if (link) {
          const cross = C.crossRepoContext(link);
          if (cross) { out = cross.text; break; }
        }

        // An explicit `switchboard attach` beats the ambient roster: the user
        // asked for one specific session's work, so give them that instead of
        // a summary of everyone. One-shot — consumed here so it can never
        // silently hijack a later session.
        const pending = store.pendingAttach(ws);
        if (pending) {
          store.consumeAttach(pending.id, sessionId);
          const target = store.getSession(pending.target_id);
          if (target) {
            const r = C.performAttach(store, ws, target, sessionId, { adopt: !!pending.adopt });
            if (r) { out = r.text; break; }
          }
        }

        const inj = C.injectionText(store, ws, sessionId);
        if (inj.text) {
          store.event('inject', { session_id: sessionId, workspace: ws, tokens: inj.tokens,
            detail: `${inj.peers} peers` });
          out = inj.text;
        }
        break;
      }

      case EV.PROMPT: {
        // FR-6.2: the first prompt is the session's intent.
        const me = store.getSession(sessionId);
        if (r.prompt && !me?.intent) {
          C.registerSession(store, {
            session_id: sessionId, cwd, workspace: ws, agent, agent_pid: agentPid,
            intent: D.truncate(D.collapse(r.prompt), 200),
          });
          // Now that we know what this session is FOR, give it a real name.
          C.nameFromWork(store, sessionId, ws, { intent: r.prompt });
          C.writeRoster(store, ws);
        } else {
          store.touch(sessionId, 'active');
        }
        // @mentions win over everything else on this turn: the user explicitly
        // pointed at a session, so answer that rather than a generic delta.
        // Unresolvable tags inject nothing, so an email address or a decorator
        // in pasted code is never mistaken for a session reference.
        const men = C.mentionText(store, ws, r.prompt, sessionId);
        if (men.cleared !== undefined) {
          notice = `${BLUE}[switchboard]${RESET} stopped referencing ` +
            `${men.cleared} session${men.cleared === 1 ? '' : 's'}`;
          break;
        }
        if (men.text) {
          store.event('mention', { session_id: sessionId, workspace: ws,
            tokens: men.tokens, detail: men.tags.join(',') });
          // A tagged session stays REFERENCED from now on.
          if (men.hits?.length) {
            C.rememberRefs(store, ws, sessionId, men.hits);
            notice = refNotice(men.hits);
          } else if (men.index) {
            notice = `${BLUE}[switchboard]${RESET} listing sessions`;
          }
          out = men.text;
          break;
        }

        // Nothing tagged this turn: feed whatever the referenced sessions have
        // done since we last reported. Silent when nothing changed.
        const delta = C.refDelta(store, ws, sessionId);
        if (delta.text) {
          store.event('refdelta', { session_id: sessionId, workspace: ws, tokens: delta.tokens });
          out = delta.text;
          notice = `${BLUE}[switchboard]${RESET} update from ` +
            delta.changed.map(c => c.target.name || '?').join(', ');
          break;
        }

        // FR-3.7 / V1 delta injection, rate-limited to at most 1 in 5 turns.
        if (shouldInjectDelta(store, ws, sessionId)) {
          const inj = C.injectionText(store, ws, sessionId, { maxTokens: 150 });
          if (inj.text) {
            store.event('inject', { session_id: sessionId, workspace: ws, tokens: inj.tokens, detail: 'delta' });
            out = inj.text;
          }
        }
        break;
      }

      case EV.PRE_TOOL: {
        // FR-4.2/4.3: warn, never deny. No permissionDecision is ever emitted.
        if (!EDIT_TOOLS.test(r.tool_name || '')) break;
        const f = filePathOf(r.tool_input);
        if (!f) break;
        const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
        const foreign = store.foreignClaims(ws, abs, sessionId);   // FR-4.6: excludes self
        if (foreign.length) {
          const warn = D.renderCollisionWarning(abs, foreign, ws);
          store.event('collision', { session_id: sessionId, workspace: ws,
            tokens: D.estimateTokens(warn), detail: D.relTo(ws, abs) });
          out = warn;
        }
        break;
      }

      case EV.POST_TOOL: {
        const tool = r.tool_name || '';
        if (EDIT_TOOLS.test(tool)) {
          const f = filePathOf(r.tool_input);
          if (f) {
            const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
            // FR-4.1 + §10.4: observed = 1. This is the T3 advantage — the
            // claim is recorded whether or not the model announced it.
            store.addClaim({ path: abs, session_id: sessionId, workspace: ws,
              ttlMs: W.DEFAULTS.claimTtlMs, op: 'edit', observed: 1 });
            recordActivity(store, sessionId, ws, { file: abs });
            C.nameFromWork(store, sessionId, ws, { files: [abs] });
            C.writeRoster(store, ws);
          }
        } else if (SHELL_TOOLS.test(tool)) {
          const cmd = commandOf(r.tool_input);
          if (cmd) recordActivity(store, sessionId, ws, { command: cmd });
        } else if (READ_TOOLS.test(tool)) {
          const f = filePathOf(r.tool_input);
          if (f) recordActivity(store, sessionId, ws, { file: path.isAbsolute(f) ? f : path.resolve(cwd, f) });
        }
        store.touch(sessionId, 'active');
        break;
      }

      case EV.STOP: {
        // FR-6.3: regenerate the digest from the turn's last message.
        if (r.last_message) recordActivity(store, sessionId, ws, { message: r.last_message });
        store.touch(sessionId, 'idle');
        C.writeRoster(store, ws);
        break;
      }

      case EV.PRE_COMPACT: {
        // FR-6.4 / JTBD-6: persist the working set before compaction destroys
        // it. This is the one hook that turns compaction from pure loss into
        // a checkpoint.
        const d = store.getDigest(sessionId);
        const me = store.getSession(sessionId);
        const claims = store.claimsFor(sessionId);
        const parts = [];
        if (me?.intent) parts.push(`intent: ${me.intent}`);
        if (claims.length) parts.push(`open files: ${claims.map(c => D.relTo(ws, c.path)).join(', ')}`);
        if (d?.last_msg) parts.push(`state: ${D.truncate(d.last_msg, 300)}`);
        if (parts.length) {
          store.addNote({ session_id: sessionId, workspace: ws,
            text: D.redact(`[pre-compaction snapshot] ${parts.join(' | ')}`), tags: 'snapshot,auto' });
        }
        break;
      }

      case EV.SESSION_END: {
        // FR-4.5 / FR-2.4: release claims so a finished session never blocks.
        store.endSession(sessionId);
        C.writeRoster(store, ws);
        break;
      }
    }
  } catch {
    out = null;                                     // ADR-8: degrade to silent
  } finally {
    try { store.close(); } catch { /* ignore */ }
  }

  return { output: out, dialect, event: ev, rawEvent, notice };
}

// Blue, to match the [SWITCHBOARD] badge in the status line.
const BLUE = '\x1b[38;5;111m';
const RESET = '\x1b[0m';

function refNotice(hits) {
  const names = hits.map(({ session }) => session.name || session.session_id.slice(0, 8));
  return `${BLUE}[switchboard]${RESET} referencing ${names.join(', ')} ` +
         `${BLUE}(active until you clear it)${RESET}`;
}

// At most one delta injection per 5 turns (§10.10 hard caps).
function shouldInjectDelta(store, ws, sessionId) {
  try {
    const rows = store._all(
      "SELECT kind FROM events WHERE workspace=? AND session_id=? AND kind IN ('inject','prompt') ORDER BY ts DESC LIMIT 5",
      ws, sessionId);
    if (rows.some(r => r.kind === 'inject')) return false;
    const peers = store.livePeers(ws, sessionId, W.DEFAULTS.liveTtlMs);
    return peers.length > 0;
  } catch { return false; }
}

function nameFor(agent, sessionId, ws, agentPid) {
  if (agent === 'claude-code' && agentPid) {
    const s = W.claudeSessionByPid(agentPid);
    if (s?.name) return s.name;
  }
  const claude = W.claudeSessionsInWorkspace(ws).find(s => s.sessionId === sessionId);
  return claude?.name || C.deriveName(agent, ws, sessionId);
}

// Entry point used by bin/switchboard-hook.js.
function run({ input, agent, event, stdout = process.stdout }) {
  let raw = {};
  try { raw = JSON.parse(input || '{}'); } catch { raw = {}; }
  const { output, dialect, notice } = handle(raw, { agent, eventOverride: event });
  if (!output && !notice) return 0;

  const evName = raw.hook_event_name || event || '';
  const payload = output ? dialect.emit(evName, output) : {};
  // `systemMessage` is shown to the USER, not the model — that is what makes a
  // resolved @tag visibly acknowledged rather than silently absorbed.
  if (notice) (payload || {}).systemMessage = notice;
  if (payload && Object.keys(payload).length) stdout.write(`${JSON.stringify(payload)}\n`);
  else if (output && dialect.alsoStdout) stdout.write(`${output}\n`);
  return 0;
}

module.exports = { handle, run, DIALECTS, EV, recordActivity, EDIT_TOOLS, SHELL_TOOLS, READ_TOOLS, filePathOf, commandOf };
