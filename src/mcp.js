'use strict';
// The universal substrate (ADR-0).
//
// Under MCP stdio the CLIENT spawns one server process per session and reaps
// it at session end. So this process's own lifetime IS the session's lifetime,
// its parent pid IS the agent, and `initialize.clientInfo` IS the agent's
// identity. Discovery, liveness, identity and workspace scope therefore cost
// zero per-agent code — that is the whole basis of "no adapters".
//
// JSON-RPC 2.0 over newline-delimited JSON. No SDK: the wire format is small
// and a dependency here would break the zero-dependency guarantee.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const W = require('./workspace');
const C = require('./core');
const D = require('./digest');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'switchboard', version: require('../package.json').version };

const TOOLS = [
  {
    name: 'sb_name',
    description:
      'Give this session a stable, human-readable name based on its actual task. Call once after ' +
      'the first substantive user request on agents without lifecycle hooks. Switchboard converts ' +
      'the task into a short unique name such as fix-oauth-refresh and shows it in every picker.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The user task in a short action-and-subject phrase, not Switchboard status text.' },
      },
      required: ['task'], additionalProperties: false,
    },
  },
  {
    name: 'sb_peers',
    description:
      'List the other AI coding sessions currently live in this workspace, what each is working on, ' +
      'and which files each has claimed. Call this before starting a task so you do not duplicate ' +
      'work or edit a file another session is mid-change on.',
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Include ENDED sessions too. Use when the user asks to see all sessions, ' +
            'or types /sbs or @sbs. Ended sessions can still be attached to.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sb_session',
    description:
      'Get the full working context of one other live session by name: its intent, the files it has ' +
      'touched, recent commands, and its latest reported finding. Use after sb_peers when a peer ' +
      'looks relevant to what you are about to do.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Session name, e.g. fix-auth-tokens, as shown by sb_peers.' } },
      required: ['name'], additionalProperties: false,
    },
  },
  {
    name: 'sb_search',
    description:
      'Search findings and notes previously posted by any session in this workspace. Use to check ' +
      '"has anyone already tried this?" before spending effort rediscovering something.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search terms.' },
        limit: { type: 'integer', description: 'Max results (default 20).' },
      },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'sb_note',
    description:
      'Post a durable finding, decision or warning to the shared workspace commons so other ' +
      'sessions — including ones started later — can find it. Use for root causes, decisions taken, ' +
      'and gotchas. Keep it to one or two sentences.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The finding, in one or two sentences.' },
        tags: { type: 'string', description: 'Optional comma-separated tags.' },
      },
      required: ['text'], additionalProperties: false,
    },
  },
  {
    name: 'sb_claim',
    description:
      'Reserve files you are about to work on, so other sessions are warned before editing them. ' +
      'Call this before a multi-file refactor. On agents without hooks this is the only way your ' +
      'claims become visible to others.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'File paths to reserve.' },
        reason: { type: 'string', description: 'Short reason, shown to other sessions.' },
      },
      required: ['paths'], additionalProperties: false,
    },
  },
  {
    name: 'sb_attach',
    description:
      "Take over another session's work. Returns that session's ENTIRE recorded context — what it " +
      'was doing, where it got to, every file it opened and touched, the commands it ran, and the ' +
      'findings it recorded — so you can continue from where it left off in this session. Use when ' +
      'the user asks to continue, resume, take over, or pick up another session\'s work. ' +
      'Call sb_peers first if you need to know which sessions exist.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name to take over, e.g. fix-auth-tokens, as shown by sb_peers.' },
        adopt: {
          type: 'boolean',
          description: 'Also take ownership of its claimed files. Only applies if that session has ended.',
        },
      },
      required: ['name'], additionalProperties: false,
    },
  },
  {
    name: 'sb_pick',
    description:
      'Show the user an interactive list of the LIVE sessions in this workspace and let them CHOOSE ' +
      'one, then return that session\'s full context so you can continue its work. This is what the ' +
      '/sbs command runs. Use it whenever the user asks to see, pick, browse or switch between ' +
      'sessions without naming one. Do not print the list yourself — this tool shows it.',
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Also offer ENDED sessions. Use when the user asks for older or finished ' +
            'sessions, or when no session is live.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sb_handoff',
    description:
      'Compose a context handoff for another live session. Returns a ready-to-send summary of this ' +
      "session's work. Deliver it with sb_message or your platform's own SendMessage tool. Use when " +
      'another session needs what you just learned.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of the session to hand off to.' },
        scope: { type: 'string', description: 'Optional focus, e.g. "the auth bug only".' },
      },
      required: ['target'], additionalProperties: false,
    },
  },
  {
    name: 'sb_message',
    description:
      'Send a durable private message to another session in this workspace. The recipient can read ' +
      'it with sb_inbox. Use for short coordination requests; use sb_handoff for a full context summary.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Recipient session name, as shown by sb_peers.' },
        text: { type: 'string', description: 'Short message to send.' },
      },
      required: ['target', 'text'], additionalProperties: false,
    },
  },
  {
    name: 'sb_broadcast',
    description:
      'Post a durable announcement to every other session in this workspace. Recipients read it ' +
      'through sb_inbox. Use sparingly for workspace-wide blockers or decisions.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Short workspace-wide announcement.' } },
      required: ['text'], additionalProperties: false,
    },
  },
  {
    name: 'sb_inbox',
    description:
      'Read unread direct messages and workspace broadcasts for this session. Messages are marked ' +
      'read by default so repeated checks return only new coordination.',
    inputSchema: {
      type: 'object',
      properties: {
        mark_read: { type: 'boolean', description: 'Mark returned messages read (default true).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sb_tasks',
    description:
      'List, create, or update durable shared tasks for this workspace. Use sb_assign separately to ' +
      'give a task to a named session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update'], description: 'Operation (default list).' },
        id: { type: 'integer', description: 'Task id for update.' },
        title: { type: 'string', description: 'Task title for create, or replacement title for update.' },
        details: { type: 'string', description: 'Optional task details.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        assigned_to: { type: 'string', description: 'For list: filter by session name or "me".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sb_assign',
    description:
      'Assign an existing shared task to a named session in this workspace. An open task becomes ' +
      'in_progress automatically when assigned.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Shared task id.' },
        target: { type: 'string', description: 'Session name, or "me".' },
      },
      required: ['id', 'target'], additionalProperties: false,
    },
  },
  {
    name: 'sb_diff',
    description:
      'Show the tracked Git working-tree diff for files another session has touched or claimed. ' +
      'Use before continuing or reviewing that session; output is capped and never executes a shell.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name whose changed files should be inspected.' },
      },
      required: ['name'], additionalProperties: false,
    },
  },
  {
    name: 'sb_release',
    description:
      'Release some or all file claims owned by this session so other sessions stop receiving ' +
      'collision warnings for work you are no longer editing.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Claims to release; omit for all.' },
      },
      additionalProperties: false,
    },
  },
];

class McpServer {
  constructor({ cwd = process.cwd(), stdout = process.stdout } = {}) {
    this.cwd = cwd;
    this.stdout = stdout;
    this.ctx = C.openContext(cwd);
    this.agentPid = W.agentPid();
    this.sessionId = null;
    this.agent = 'unknown';
    this.name = null;
    this.registered = false;
    this.pending = new Map();   // outbound requests awaiting a client response
    this.reqSeq = 0;
    this.clientCaps = null;
  }

  send(msg) {
    try { this.stdout.write(`${JSON.stringify(msg)}\n`); } catch { /* peer gone */ }
  }
  reply(id, result) { if (id !== undefined && id !== null) this.send({ jsonrpc: '2.0', id, result }); }
  fail(id, code, message) {
    if (id !== undefined && id !== null) this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  handleLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return this.fail(null, -32700, 'parse error'); }
    if (Array.isArray(msg)) { msg.forEach(m => this.dispatch(m)); return; }
    this.dispatch(msg);
  }

  // ---- server -> client requests (elicitation) -----------------------------

  // MCP lets a SERVER ask the CLIENT for input mid-tool-call. Claude Code
  // renders an enum schema as an interactive picker, which is how `/sbs` gets
  // an arrow-key list INSIDE a session — the session owns stdin, so a terminal
  // TUI is impossible there, but the client can draw one on our behalf.
  request(method, params, timeoutMs = 120_000) {
    return new Promise(resolve => {
      const id = `sb-${++this.reqSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);                          // never hang a tool call
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // Ask the user to choose one session. Returns the chosen value, or null when
  // the client can't elicit, the user declines, or nothing answers in time.
  async elicitChoice({ message, options }) {
    if (!this.clientCaps?.elicitation) return null;
    const res = await this.request('elicitation/create', {
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            title: 'Session',
            description: 'The exact, complete session name whose work you want to continue.',
            enum: options.map(o => o.value),
            enumNames: options.map(o => o.label),
          },
        },
        required: ['session'],
      },
    });
    if (!res || res.action !== 'accept') return null;
    return res.content?.session ?? null;
  }

  dispatch(msg) {
    const { id, method, params } = msg || {};

    // A response to a request WE sent (elicitation). Route it, don't drop it.
    if (!method && id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(msg.error ? null : msg.result);
      return;
    }
    if (!method) return;                       // any other stray response
    try {
      switch (method) {
        case 'initialize':                return this.onInitialize(id, params);
        case 'notifications/initialized': return;
        case 'ping':                      return this.reply(id, {});
        case 'tools/list':                return this.reply(id, { tools: TOOLS });
        case 'tools/call':                return this.onToolCall(id, params);
        case 'resources/list':            return this.reply(id, { resources: [] });
        case 'prompts/list':              return this.reply(id, { prompts: [] });
        case 'shutdown':                  return this.reply(id, {});
        default:
          if (method.startsWith('notifications/')) return;
          return this.fail(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      // ADR-8: never let a tool bug kill the session's MCP connection.
      this.fail(id, -32603, `internal error: ${e && e.message}`);
    }
  }

  onInitialize(id, params) {
    const client = params?.clientInfo || {};
    this.clientCaps = params?.capabilities || {};
    this.agent = W.normalizeAgent(client.name);
    const ident = C.resolveIdentity({ agent: this.agent, cwd: this.cwd, agent_pid: this.agentPid, store: this.ctx.store });
    this.sessionId = ident.session_id;
    this.name = ident.name || C.deriveName(this.agent, this.ctx.workspace, this.sessionId);

    if (this.ctx.ok) {
      C.ensureStoreDir(this.ctx.workspace);
      C.registerSession(this.ctx.store, {
        session_id: this.sessionId,
        cwd: this.cwd,
        workspace: this.ctx.workspace,
        agent: this.agent,
        agent_ver: ident.agent_ver || client.version || null,
        name: this.name,
        tier: 1,                       // hooks upgrade this to 3 themselves
        synthetic: ident.synthetic,    // absorbed by the hook row if one appears
        agent_pid: this.agentPid,
        status: 'active',
      });
      this.registered = true;
      C.sweep(this.ctx.store, this.ctx.workspace);
    }

    // Echo the client's protocol version when we understand it, per MCP's
    // version-negotiation rule; otherwise offer ours.
    const requested = params?.protocolVersion;
    const version = typeof requested === 'string' && requested >= '2024-11-05'
      ? requested : PROTOCOL_VERSION;
    const startup = this.ctx.ok ? C.startupContext(this.ctx.store, this.ctx.workspace, this.sessionId) : '';

    this.reply(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        (W.isTerminalWorkspace(this.ctx.workspace)
          ? 'You are connected to Switchboard local terminals. Sessions outside Git repositories under this user account share this group, even from different directories. Use sb_peers to find another terminal, sb_session or sb_attach to read its saved context, and sb_message/sb_inbox to exchange messages. Messages are read when the recipient checks its inbox; they do not wake another terminal. ' : '') +
        'Other AI coding sessions may be working in this workspace right now. Call sb_inbox and ' +
        'sb_peers before starting a task to collect messages, see what peers are doing, and avoid ' +
        'claimed files. After the first substantive user request, call sb_name with a short summary ' +
        'of that task so this session is recognizable in pickers. Every session entry labels its ' +
        'Exact session name. When the user writes ' +
        '@<name>, copy that name character-for-character into sb_session; never infer or shorten it. ' +
        'Post findings with sb_note so later sessions can find them.' + (startup ? `\n\n${startup}` : ''),
    });
  }

  onToolCall(id, params) {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!this.ctx.ok) return this.reply(id, text('Switchboard store unavailable; continuing without shared context.'));

    this.ctx.store.touch(this.sessionId, 'active');
    const fn = this.tools()[name];
    if (!fn) return this.fail(id, -32602, `unknown tool: ${name}`);

    Promise.resolve(fn(args)).then(out => {
      this.ctx.store.event('pull', {
        session_id: this.sessionId, workspace: this.ctx.workspace,
        tokens: D.estimateTokens(out), detail: name,
      });
      C.writeRoster(this.ctx.store, this.ctx.workspace);
      this.reply(id, text(out));
    }, e => this.fail(id, -32603, `tool failed: ${e && e.message}`));
  }

  tools() {
    const store = this.ctx.store;
    const ws = this.ctx.workspace;
    const self = this.sessionId;

    return {
      sb_name: ({ task }) => {
        const current = store.getSession(self);
        if (current?.named && current.name) return `Exact session name: ${current.name}\nReference exactly as: @${current.name}`;
        if (!C.isMeaningfulTask(task)) {
          return 'Could not create a useful session name from Switchboard or slash-command text. Pass the actual user task.';
        }
        if (!current?.intent || !C.isMeaningfulTask(current.intent)) {
          store.upsertSession({ session_id: self, intent: D.redact(D.truncate(D.collapse(task), 200)) });
        }
        const name = C.nameFromWork(store, self, ws, { intent: D.redact(task) });
        C.writeRoster(store, ws);
        return name
          ? `Exact session name: ${name}\nReference exactly as: @${name}`
          : 'Could not derive a session name. Use a short action-and-subject task phrase.';
      },

      sb_peers: ({ all } = {}) => {
        C.sweep(store, ws);
        // `all` is the full directory: live AND ended, every handle visible.
        if (all) return C.sessionIndex(store, ws, self, { maxTokens: 4000, all: true }).body;
        const ctx = C.rosterContext(store, ws, self);
        if (!ctx.peers.length) {
          // Nothing live, but ended sessions are still recoverable work — say
          // so rather than answering with a flat "nobody here".
          const idx = C.sessionIndex(store, ws, self, { maxTokens: 2000, all: true });
          return idx.sessions.length
            ? `No other sessions are LIVE right now, but these ended sessions can still be attached to:\n\n${idx.body}`
            : 'No other sessions are live in this workspace right now.';
        }
        // Pull path: no cap — the model asked, so give it the detail (ADR-1).
        return D.renderRoster(ctx.peers, ctx, { maxTokens: 4000 });
      },

      sb_session: ({ name }) => {
        const target = C.findTarget(store, ws, name, self);
        if (!target) {
          const avail = store.attachCandidates(ws, self, W.DEFAULTS.liveTtlMs)
            .map(p => p.name || p.session_id.slice(0, 8)).join(', ') || '(none)';
          return `No session named "${name}". Sessions: ${avail}`;
        }
        const ctx = C.attachContext(store, ws, target.session_id);
        return D.wrapForInjection(D.renderSessionDetail(ctx, { maxTokens: 1500 }));
      },

      sb_search: ({ query, limit }) => {
        const rows = store.search(ws, String(query || ''), Math.min(Number(limit) || 20, 50));
        if (!rows.length) return `No prior findings match "${query}".`;
        const out = rows.map(r => {
          const s = store.getSession(r.session_id);
          const who = s?.name || (r.session_id || '').slice(0, 8) || 'unknown';
          // Posted notes and observed activity are both useful, but the reader
          // should know which is which.
          const kind = r.kind === 'note' ? 'note' : 'activity';
          return `• [${D.ago(Date.now() - r.ts)} · ${who} · ${kind}] ${r.text}${r.tags ? `  (${r.tags})` : ''}`;
        });
        return D.wrapForInjection(`${rows.length} prior finding(s):\n${out.join('\n')}`);
      },

      sb_note: ({ text: t, tags }) => {
        const clean = D.redact(D.truncate(String(t || '').trim(), 1000));
        if (!clean) return 'Nothing to record: text was empty.';
        store.addNote({ session_id: self, workspace: ws, text: clean, tags: tags || null });
        store.event('note', { session_id: self, workspace: ws, tokens: D.estimateTokens(clean) });
        return `Recorded for other sessions in this workspace: "${D.truncate(clean, 120)}"`;
      },

      sb_claim: ({ paths, reason }) => {
        const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(String);
        if (!list.length) return 'No paths given; nothing claimed.';
        const conflicts = [];
        for (const p of list) {
          const base = W.isTerminalWorkspace(ws) ? this.cwd : ws;
          const abs = path.resolve(base, p);
          const foreign = store.foreignClaims(ws, abs, self);
          if (foreign.length) conflicts.push(D.renderCollisionWarning(abs, foreign, ws));
          // T1 claims are self-declared (observed = 0) — provenance is kept.
          store.addClaim({
            path: abs, session_id: self, workspace: ws,
            ttlMs: W.DEFAULTS.claimTtlMs, op: 'reserve', observed: 0,
            reason: reason ? D.truncate(String(reason), 120) : null,
          });
        }
        C.writeRoster(store, ws);
        const head = `Claimed ${list.length} file(s) for this session; other sessions will be warned.`;
        return conflicts.length ? `${head}\n\nHeads up — already claimed elsewhere:\n${conflicts.join('\n')}` : head;
      },

      sb_release: ({ paths } = {}) => {
        const requested = Array.isArray(paths) ? paths.filter(Boolean).map(String) : [];
        const base = W.isTerminalWorkspace(ws) ? this.cwd : ws;
        const absolute = requested.map(p => path.resolve(base, p));
        const released = store.releaseSelectedClaims(self, absolute);
        C.writeRoster(store, ws);
        return requested.length
          ? `Released ${released} matching file claim(s) from this session.`
          : `Released all ${released} file claim(s) from this session.`;
      },

      sb_message: ({ target, text: message }) => {
        const peer = C.findTarget(store, ws, target, self);
        if (!peer) return `No live session matches "${target}". Call sb_peers to see available names.`;
        const clean = cleanSharedText(message, 1000);
        if (!clean) return 'Nothing sent: message text was empty.';
        const messageId = store.addMessage({
          workspace: ws, from_session: self, to_session: peer.session_id, text: clean,
        });
        return messageId
          ? `Message #${messageId} sent to "${peer.name || peer.session_id.slice(0, 8)}".`
          : 'Message could not be stored; continuing without blocking your work.';
      },

      sb_broadcast: ({ text: message }) => {
        const clean = cleanSharedText(message, 1000);
        if (!clean) return 'Nothing broadcast: message text was empty.';
        const messageId = store.addMessage({ workspace: ws, from_session: self, text: clean });
        return messageId
          ? `Broadcast #${messageId} posted to every other session in this workspace.`
          : 'Broadcast could not be stored; continuing without blocking your work.';
      },

      sb_inbox: ({ mark_read: markRead = true } = {}) => {
        const rows = store.unreadMessages(ws, self, 30);
        if (!rows.length) return 'No unread Switchboard messages.';
        if (markRead !== false) store.markMessagesRead(self, rows.map(r => r.id));
        const body = rows.map(r => {
          const who = r.from_name || r.from_session.slice(0, 8);
          const kind = r.to_session ? 'direct' : 'broadcast';
          return `• #${r.id} [${kind} · ${who} · ${D.ago(Date.now() - r.created_at)}] ${r.text}`;
        }).join('\n');
        return D.wrapForInjection(`${rows.length} unread Switchboard message(s):\n${body}`);
      },

      sb_tasks: ({ action = 'list', id, title, details, status, assigned_to: assignedTo } = {}) => {
        if (action === 'create') {
          const cleanTitle = cleanSharedText(title, 160);
          if (!cleanTitle) return 'Task not created: title was empty.';
          const taskId = store.addTask({
            workspace: ws, title: cleanTitle,
            details: cleanSharedText(details, 1200) || null, created_by: self,
          });
          return taskId ? `Created shared task #${taskId}: ${cleanTitle}` : 'Task could not be stored.';
        }

        if (action === 'update') {
          const taskId = positiveId(id);
          if (!taskId) return 'Task update requires a positive integer id.';
          if (status && !TASK_STATUSES.has(status)) return `Invalid task status "${status}".`;
          const patch = {};
          if (title !== undefined) {
            patch.title = cleanSharedText(title, 160);
            if (!patch.title) return 'Task title cannot be empty.';
          }
          if (details !== undefined) patch.details = cleanSharedText(details, 1200);
          if (status !== undefined) patch.status = status;
          if (!Object.keys(patch).length) return 'Nothing to update.';
          const updated = store.updateTask(ws, taskId, patch);
          return updated ? `Updated task #${taskId}: ${taskLine(updated)}` : `No task #${taskId} in this workspace.`;
        }

        if (action !== 'list') return `Unknown task action "${action}".`;
        if (status && !TASK_STATUSES.has(status)) return `Invalid task status "${status}".`;
        let assignedId = null;
        if (assignedTo) {
          const target = resolveTaskTarget(store, ws, self, assignedTo);
          if (!target) return `No live session matches "${assignedTo}".`;
          assignedId = target.session_id;
        }
        const rows = store.tasks(ws, { status: status || null, assignedTo: assignedId, limit: 50 });
        if (!rows.length) return 'No shared tasks match those filters.';
        return D.wrapForInjection(`${rows.length} shared task(s):\n${rows.map(taskLine).join('\n')}`);
      },

      sb_assign: ({ id, target }) => {
        const taskId = positiveId(id);
        if (!taskId) return 'Assignment requires a positive integer task id.';
        const session = resolveTaskTarget(store, ws, self, target);
        if (!session) return `No live session matches "${target}". Call sb_peers to see available names.`;
        const updated = store.assignTask(ws, taskId, session.session_id);
        return updated
          ? `Assigned task #${taskId} to "${session.name || session.session_id.slice(0, 8)}".`
          : `No task #${taskId} in this workspace.`;
      },

      sb_diff: ({ name }) => {
        if (W.isTerminalWorkspace(ws)) return 'These sessions are outside Git repositories. No repository diff is available; use sb_session to inspect recorded files and notes.';
        const target = C.findTarget(store, ws, name, self);
        if (!target) return `No live session matches "${name}". Call sb_peers to see available names.`;
        const digest = store.getDigest(target.session_id);
        const claimed = store.claimsFor(target.session_id).map(c => c.path);
        const files = safeWorkspaceFiles(ws, [...claimed, ...(digest?.files || [])]);
        if (!files.length) return `Session "${target.name || name}" has no recorded files to diff.`;

        const baseArgs = ['diff', '--no-ext-diff', '--unified=3'];
        let result = spawnSync('git', [...baseArgs, 'HEAD', '--', ...files], {
          cwd: ws, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        });
        // A new repository may not have HEAD yet; show its index/worktree diff.
        if (result.status !== 0) result = spawnSync('git', [...baseArgs, '--', ...files], {
          cwd: ws, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        });
        if (result.error) return `Could not inspect Git diff: ${result.error.message}`;
        const diff = String(result.stdout || '').trim();
        if (!diff) return `No tracked Git diff for ${files.length} file(s) recorded by "${target.name || name}".`;
        return D.wrapForInjection(D.capText(
          `Tracked Git diff for "${target.name || name}" (${files.join(', ')}):\n\n${diff}`, 3500));
      },

      sb_pick: async ({ all } = {}) => {
        C.sweep(store, ws);
        const idx = C.sessionIndex(store, ws, self, { maxTokens: 4000, all: !!all });
        if (!idx.sessions.length) {
          return idx.endedCount
            ? `No sessions are live in this workspace. ${idx.endedCount} ended session(s) can still be continued — call sb_pick with all:true.`
            : 'No sessions recorded in this workspace yet.';
        }

        const options = idx.sessions.map(s2 => {
          // sessionIndex excludes bootstrap aliases, so every value exposed to
          // the picker is a stable semantic name.
          const nm = s2.name;
          return {
            value: nm,
            label: `${nm} · ${s2.live ? 'live' : 'ended'}`,
          };
        });

        const chosen = await this.elicitChoice({
          message: `Choose the exact session name (${idx.sessions.length} in this workspace)`,
          options,
        });

        // No elicitation support, or the user dismissed it: fall back to the
        // printed index so the request is never a dead end.
        if (!chosen) {
          return this.clientCaps?.elicitation
            ? `No session selected.\n\n${idx.body}`
            : idx.body;
        }

        const target = C.findTarget(store, ws, chosen, self);
        if (!target) return `Could not resolve "${chosen}".\n\n${idx.body}`;
        const r = C.performAttach(store, ws, target, self, {});
        return r ? r.text : `Could not read context for "${chosen}".`;
      },

      sb_attach: ({ name, adopt }) => {
        C.sweep(store, ws);
        const target = C.findTarget(store, ws, name, self);
        if (!target) {
          const opts = store.attachCandidates(ws, self, W.DEFAULTS.liveTtlMs)
            .map(s => `${s.name || s.session_id.slice(0, 8)}${s.live ? '' : ' (ended)'}`);
          return opts.length
            ? `No session matches "${name}". Available: ${opts.join(', ')}`
            : 'There are no other sessions in this workspace to attach to.';
        }
        const r = C.performAttach(store, ws, target, self, { adopt: !!adopt });
        if (!r) return `Could not read context for "${name}".`;
        const note = r.adopted
          ? `\n\n(Adopted ${r.adopted} file claim(s) from it — you now own those files.)`
          : (adopt && r.live ? '\n\n(Did not adopt claims: that session is still running.)' : '');
        return `${r.text}${note}`;
      },

      sb_handoff: ({ target, scope }) => {
        const d = store.getDigest(self);
        const claims = store.claimsFor(self);
        const me = store.getSession(self);
        const parts = [];
        if (me?.intent) parts.push(`Working on: ${me.intent}`);
        if (scope) parts.push(`Focus: ${scope}`);
        if (d?.last_msg) parts.push(`Latest: ${d.last_msg}`);
        if (claims.length) parts.push(`Files I have open: ${claims.map(c => D.relTo(ws, c.path)).join(', ')}`);
        if (d?.files?.length) parts.push(`Files touched: ${d.files.slice(-15).join(', ')}`);
        const body = parts.join('\n') || 'No significant context recorded for this session yet.';
        // ADR-6: we compose, the platform delivers. We cannot call the agent's
        // own SendMessage from inside an MCP server, so we hand back the text.
        return [
          `Handoff prepared for "${target}". Deliver it with sb_message or your platform's`,
          'cross-session SendMessage tool; otherwise show it to the user.',
          '',
          '--- message ---',
          body,
          '--- end ---',
        ].join('\n');
      },
    };
  }

  // Session death is a process exit. Nothing to poll, nothing to supervise.
  shutdown() {
    if (this.ctx.ok && this.registered && this.sessionId) {
      try {
        this.ctx.store.endSession(this.sessionId);
        C.writeRoster(this.ctx.store, this.ctx.workspace);
      } catch { /* best effort */ }
    }
    try { this.ctx.store?.close(); } catch { /* ignore */ }
  }
}

const TASK_STATUSES = new Set(['open', 'in_progress', 'done', 'cancelled']);

function cleanSharedText(value, maxChars) {
  return D.redact(D.truncate(String(value ?? '').trim(), maxChars));
}

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function resolveTaskTarget(store, workspace, selfId, name) {
  if (String(name || '').trim().toLowerCase() === 'me') return store.getSession(selfId);
  return C.findTarget(store, workspace, name, selfId);
}

function taskLine(task) {
  const assigned = task.assigned_name || (task.assigned_to ? task.assigned_to.slice(0, 8) : 'unassigned');
  const detail = task.details ? ` — ${D.truncate(D.collapse(task.details), 180)}` : '';
  return `• #${task.id} [${task.status}] ${task.title} · ${assigned}${detail}`;
}

function safeWorkspaceFiles(workspace, files) {
  const out = [];
  for (const file of files || []) {
    if (!file) continue;
    const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(workspace, String(file));
    const relative = path.relative(workspace, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!out.includes(relative)) out.push(relative);
  }
  return out.slice(0, 50);
}

function text(s) { return { content: [{ type: 'text', text: String(s) }] }; }

// Wire the server to stdin/stdout with newline framing.
function run({ cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout } = {}) {
  const server = new McpServer({ cwd, stdout });
  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      server.handleLine(line);
    }
  });
  const bye = () => { server.shutdown(); process.exit(0); };
  stdin.on('end', bye);
  stdin.on('close', bye);
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('uncaughtException', () => { server.shutdown(); process.exit(0); });
  // Heartbeat so a session idle for hours still reads as live (FR-2.2).
  const hb = setInterval(() => {
    if (server.ctx.ok && server.sessionId) server.ctx.store.touch(server.sessionId, 'idle');
  }, 45_000);
  hb.unref?.();
  return server;
}

module.exports = { McpServer, run, TOOLS, PROTOCOL_VERSION };
