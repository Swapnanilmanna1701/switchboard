# switchboard

**Ambient shared working memory for concurrent AI coding sessions in one workspace.**

You open five agent sessions in one repo. Each starts blind. None knows what the
others found, decided, or are mid-edit on — so *you* become the message bus,
copy-pasting findings and refereeing conflicting edits.

Switchboard makes those sessions aware of each other. Zero config, zero
dependencies, no daemon, no editor extension.

```bash
npx switchboard init
```

## What it does

1. **Cold-start priming** — a new session opens already knowing what the other live sessions are doing.
2. **Collision guard** — a session is warned *before* editing a file another session has claimed.
3. **Shared findings** — one session posts a root cause; every later session can find it.
4. **Attach** — pick any session, live or ended, and continue its work with its full context.

A fresh session receives this, automatically, at startup:

```
[switchboard] 2 live sessions in this workspace:

• debug-login-500-errors (sbs1) [Claude Code] — idle 4m
  debugging the login 500 errors
  editing: middleware/session.ts
  latest: root cause: exp claim compared in ms not seconds

• restyle-checkout-form (sbs2) [Cursor] — active just now
  editing: components/Checkout.tsx

Refer to a session by its short handle: type @sbs1 to pull it into context,
or /sbs1 to continue its work.
```

Sessions name themselves from what they're doing — mechanically, no LLM call —
and keep that name for life. `sbs1` is just a short alias for typing.

## Continue another session's work

```bash
switchboard sbs                  # arrow-key picker — browsing costs 0 tokens
switchboard sbs 2                # or select directly by number,
switchboard sbs debug-login-500-errors   # by name,
switchboard sbs sbs1             # or by handle
claude                           # that session's full context loads here
```

The picker lists **live and ended** sessions — continuing work from a session
you already closed is the most valuable case, so it is not hidden.

```
  switchboard  ~/work/api
  3 sessions · 2 live · 1 ended

▶ debug-login-500-errors  sbs1  [Claude Code]  live   4m
       debugging the login 500 errors
       middleware/session.ts

  restyle-checkout-form   sbs2  [Cursor]       live   just now
  migrate-content-schema  sbs3  [Claude Code]  ended  2h

  ↑/↓ move · enter select · q or esc cancel
```

## Reference a session mid-conversation

| You type | You get | Cost |
|---|---|---|
| *(nothing)* | ambient roster at session start | ~500 tok |
| `@sbs` or `/sbs` | every session, live and ended | ~300 tok |
| `@sbs1` / `@<name>` | that session's detail | ~800 tok |
| `/sbs1` | take over its work, full context | ~3000 tok |
| `switchboard sbs` | the picker | **0 tok** |

An `@tag` that matches no session injects **nothing** — an email address or a
`@decorator` in pasted code never triggers a false injection.

## Works with

Support comes from two standards these agents already implement, so there are
**no per-agent adapters** — an agent that speaks MCP works on day one.

| Tier | What you get | Agents |
|---|---|---|
| **T3** automatic | Auto-injection, hook-**observed** file claims, collision guard | Claude Code, Cursor, Gemini CLI, OpenCode |
| **T1** full features | All tools on demand, self-declared claims | Windsurf, Codex, Copilot, Cline, Roo, Kilo, Continue, Zed, Goose, Qwen, Amazon Q |
| **T2** passive | Reads `.switchboard/ROSTER.md` — it's just a file | anything |
| **T0** instruction | An `AGENTS.md` stanza pointing at the above | 30+ agents |

**One honest difference:** claim *attribution* needs interception, and only
hooks intercept. T3 claims are observed automatically; T1 claims are declared by
the model calling `sb_claim`. The roster labels which is which — `(observed)`
vs `(self-declared)` — rather than pretending they're equivalent.

## Commands

```bash
npx switchboard init [--dry-run] [--all] [--local]
npx switchboard status [--json] [--raw]
npx switchboard board          # live roster, refreshes every 3s
npx switchboard doctor         # per-agent tier report
npx switchboard uninstall [--purge]
```

`init` detects installed agents, writes MCP config for each, adds hooks where
supported, and appends one static `AGENTS.md` stanza. It is idempotent, prints
exactly what it changed, and `uninstall` reverses all of it.

## Tools (MCP)

| Tool | Purpose |
|---|---|
| `sb_peers` | Who else is live, what they're doing, what they've claimed |
| `sb_session(name)` | One peer's full context: files, commands, latest finding |
| `sb_search(query)` | "Has anyone already tried this?" across notes and activity |
| `sb_note(text)` | Post a finding for current and future sessions |
| `sb_claim(paths)` | Reserve files before a refactor |
| `sb_attach(name)` | Take over a session's work with its entire recorded context |
| `sb_handoff(target)` | Compose a context handoff for another session |

## How it works

An MCP server is a **universal session registry**. Under stdio the agent spawns
one server process per session and reaps it at session end — so the process
lifetime *is* the session lifetime, its parent pid *is* the agent, and
`initialize.clientInfo` *is* the agent's identity. Discovery, liveness and
identity therefore cost zero per-agent code.

```
Claude Code   Cursor   Codex   Gemini CLI     ← any MCP client
     │          │        │         │
     └──────────┴────────┴─────────┘
                 │  one server process per session
        .switchboard/state.db   (SQLite, WAL, FTS5)
                 │
        .switchboard/ROSTER.md  ← readable by anything
```

No daemon. No port. No background process. The database is the shared state.

## Design rules

- **Warn, never block.** A false-positive block gets a tool uninstalled; a
  false-positive warning costs ~40 tokens.
- **Context is a budget.** The startup digest is hard-capped at 500 tokens, and
  is **exactly zero** when you're the only session.
- **Observe, don't ask.** Claims come from watching edits, not from trusting the
  model to announce them.
- **Fail open.** Any error, timeout or corrupt store injects nothing and exits
  0. This must never be why a session fails to start.
- **Never leaves the machine.** No network in the data path, no telemetry, no
  listening socket. Secrets are redacted before they're stored.
- **Peer text is data, not instructions.** Injected content is wrapped in an
  envelope that says so.

## Requirements

Node ≥ 22 (for `node:sqlite`). macOS, Linux, WSL2. Zero runtime dependencies.

## Development

```bash
node test/test.js        # 167 checks, no framework
```

## Docs

`switchboard-prd.md` · `switchboard-compatibility-report.md`

MIT.
