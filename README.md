# switchboard

**Ambient shared working memory for concurrent AI coding sessions in one workspace.**

You open five agent sessions in one repo. Each starts blind. None knows what the
others found, decided, or are mid-edit on — so *you* become the message bus,
copy-pasting findings between windows and refereeing conflicting edits.

Switchboard makes those sessions aware of each other. Zero config, zero runtime
dependencies, no daemon, no editor extension.

```bash
npx switchboard init
```

---

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [How sessions are named](#how-sessions-are-named)
- [Referencing another session](#referencing-another-session)
- [The `/sbs` picker](#the-sbs-picker)
- [Continuing another session's work](#continuing-another-sessions-work)
- [CLI reference](#cli-reference)
- [MCP tools](#mcp-tools)
- [Agent support](#agent-support)
- [How it works](#how-it-works)
- [What it stores, and where](#what-it-stores-and-where)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)
- [Development](#development)

---

## What it does

**1. Cold-start priming.** A new session opens already knowing what the other
live sessions are doing.

**2. Collision guard.** A session is warned *before* editing a file another
session has claimed.

**3. Shared findings.** One session posts a root cause; every later session can
find it — including sessions started tomorrow.

**4. Attach.** Pick any session, live or ended, and continue its work with its
full context.

A fresh session receives something like this automatically at startup:

```
[switchboard] 2 live sessions in this workspace:

• fix-login-500-errors  [Claude Code]  idle 4m
      debugging the login 500 errors
      editing: middleware/session.ts
      latest: root cause: exp claim compared in ms not seconds

• restyle-checkout-form  [Cursor]  active just now
      editing: components/Checkout.tsx

Reference a session in a prompt with @<name>, e.g. @fix-login-500-errors.
Run /sbs to pick one and continue its work.
```

---

## Install

Per repo, from inside the repo:

```bash
npx switchboard init
```

That detects which agents you actually use and writes only their configs. To see
the plan without writing anything:

```bash
npx switchboard init --dry-run
```

Useful variants:

| Command | Effect |
|---|---|
| `npx switchboard init` | Configure detected agents only |
| `npx switchboard init --all` | Configure every supported agent |
| `npx switchboard init --local` | Point configs at a local checkout instead of `npx` |
| `npx switchboard init --dry-run` | Print the plan, write nothing |

**Requires Node 22.5.0+** — switchboard uses the built-in `node:sqlite` module,
which is why it has no dependencies.

Verify afterwards:

```bash
npx switchboard doctor
```

### What `init` writes

Nothing outside your repo, except agent config files that are user-scoped by the
agent's own design (for example Codex's `~/.codex/config.toml`).

```
.mcp.json                    MCP server registration
.claude/settings.json        lifecycle hooks
.claude/commands/sbs.md      the /sbs picker command
.vscode/mcp.json             VS Code MCP registration
AGENTS.md                    a short stanza between markers
.git/info/exclude            adds .switchboard/ — never your .gitignore
```

The `AGENTS.md` stanza is written between `<!-- switchboard:begin -->` and
`<!-- switchboard:end -->` markers and is rewritten in place on upgrade, so your
own content is never touched. Switchboard writes to `.git/info/exclude` rather
than `.gitignore` deliberately — your ignore file is yours, and shouldn't gain
entries because you installed a tool.

---

## How sessions are named

Every session gets a name describing what it is doing, derived mechanically from
its early activity — no LLM call, no token cost:

```
fix-astro-dev-server
restyle-checkout-form
add-password-recovery
```

Before a session has done enough to name itself, it falls back to a
workspace-derived name (`logline2-4c`). A session is **named once and never
renamed**, so a name you saw an hour ago still refers to the same session.
Collisions get a short disambiguating suffix.

There are no `sbs1` / `sbs2` style handles. Names are the only address.

---

## Referencing another session

Type `@` followed by a session name in any prompt:

```
@fix-astro-dev-server what did you conclude about the port binding?
```

The referenced session's context is resolved and injected before your agent sees
the prompt. Works for live *and* ended sessions.

To see what names are available, run `/sbs` (below) or:

```bash
npx switchboard sessions --all
```

---

## The `/sbs` picker

Type `/sbs` in an agent session, or run `npx switchboard sbs` in a terminal:

```
  switchboard  /Users/you/code/api

  3 sessions · 2 live · 1 ended

 fix-login-500-errors            [Claude Code]  live    4m
       debugging the login 500 errors
       middleware/session.ts, lib/jwt.ts

 restyle-checkout-form           [Cursor]       live   now
       components/Checkout.tsx

 migrate-user-table              [Claude Code]  ended   2h
       migrating the users table to uuid keys

  ↑/↓ move · enter select · q or esc cancel
```

Arrow keys to move, Enter to select, `q` or Esc to cancel. You can also type a
number to jump straight to a row.

**Browsing costs zero tokens.** The picker runs in your terminal, not inside the
model's context. The model only ever sees the one session you actually choose —
scrolling past nine irrelevant sessions costs nothing. A slash command that
asked the model to print the list would burn context on every row.

If stdin isn't a TTY (piped input, CI, some wrapper terminals), it falls back to
a numbered prompt that accepts a number, a name, or a name prefix.

Select without the picker:

```bash
npx switchboard sbs fix-login-500-errors
npx switchboard sbs --all          # include ended sessions
npx switchboard sbs <name> --run   # pick, then launch claude immediately
```

---

## Continuing another session's work

Just ask, in plain language:

> continue the work from @fix-astro-dev-server

Or explicitly:

```bash
npx switchboard attach fix-astro-dev-server
```

Attaching returns that session's full working context — its intent, every file
it opened and touched, the commands it ran, and the findings it recorded — so
the current session can pick up where it left off.

| Flag | Effect |
|---|---|
| `--list` | Show attachable sessions without picking |
| `--adopt` | Also take over its file claims (ended sessions only) |
| `--cancel` | Clear a queued attach |

`--adopt` is deliberately restricted to ended sessions — taking over a live
session's claims would defeat the collision guard.

---

## CLI reference

```
npx switchboard init [--dry-run] [--all] [--local]
npx switchboard status [--json] [--raw]
npx switchboard sbs [name] [--run] [--all]
npx switchboard sessions [--all]
npx switchboard attach [name] [--list] [--adopt] [--cancel]
npx switchboard board
npx switchboard doctor
npx switchboard statusline install|uninstall|status
npx switchboard uninstall [--purge]
npx switchboard purge
```

| Command | What it does |
|---|---|
| `init` | Install into the current repo |
| `status` | What switchboard knows about this workspace |
| `sbs` | Interactive session picker |
| `sessions` | List live sessions (`--all` adds ended ones) |
| `attach` | Continue another session's work |
| `board` | Human-readable roster of the workspace |
| `doctor` | Diagnose the install; surfaces schema errors |
| `statusline` | Manage the `[switchboard]` status line badge |
| `uninstall` | Remove configs (`--purge` also drops stored data) |
| `purge` | Drop all stored data, keep configs |

| Flag | Meaning |
|---|---|
| `--dry-run` | Show the plan, write nothing |
| `--all` | Every supported agent, not just detected ones |
| `--local` | Point configs at this checkout instead of `npx` |
| `--json` | Machine-readable status |
| `--raw` | Dump everything stored — inspect before you trust it |

### Status line

```bash
npx switchboard statusline install
```

Adds a `[switchboard]` badge to your agent's status line, chaining any status
line you already have rather than replacing it. The badge is deliberately bare —
no peer counts, no session handles, nothing that reads like a name.

---

## MCP tools

Switchboard registers an MCP server exposing eight tools. Agents call these on
their own; you rarely invoke them directly.

| Tool | Purpose |
|---|---|
| `sb_peers` | List other live sessions, what each is doing, which files each claimed |
| `sb_session` | Full working context of one named session |
| `sb_search` | Search findings and notes posted by any session |
| `sb_note` | Post a durable finding, decision, or warning |
| `sb_claim` | Reserve files you're about to change |
| `sb_attach` | Load another session's context to continue its work |
| `sb_pick` | Show the interactive picker and return the chosen session |
| `sb_handoff` | Compose a context handoff for another live session |

`sb_claim` matters most on agents without hook support — it's the only way your
claims become visible to others there.

---

## Agent support

Support comes in tiers. Every agent gets the MCP tools; hooks add the automatic,
zero-effort behaviour on top.

**Full support — MCP tools *and* lifecycle hooks.** Priming and collision
warnings happen automatically, no prompting needed.

- Claude Code
- Cursor
- Gemini CLI
- OpenCode

**MCP support — tools work, hooks don't exist.** The agent must call `sb_peers`
and `sb_claim` itself; the `AGENTS.md` stanza tells it to.

- Windsurf, Codex CLI, Copilot, Cline, Roo Code, Kilo Code, Continue, Zed,
  Goose, Qwen Code, Amazon Q, Aider

**Anything else** — any agent that reads `AGENTS.md` gets the roster file at
`.switchboard/ROSTER.md`, which is plain Markdown.

The architecture is why this list is long: an MCP server under stdio transport
is already one process per session, so it *is* a session registry. Cross-agent
support needs no per-agent adapters.

---

## How it works

Four tiers, degrading gracefully:

| Tier | Mechanism | Needs |
|---|---|---|
| T0 | `AGENTS.md` instruction | Any agent that reads AGENTS.md |
| T1 | MCP tools, pulled on demand | MCP support |
| T2 | `.switchboard/ROSTER.md` file | Nothing — it's just a file |
| T3 | Lifecycle hooks, fully automatic | One of the four hook-capable agents |

Storage is SQLite via Node's built-in `node:sqlite`, with WAL journaling and an
FTS5 index over notes. Schema changes apply as additive `ALTER TABLE ADD COLUMN`
migrations on every open, so upgrading never requires a wipe.

**Liveness is decided by process, not by clock.** A session is live if its
process is alive — not if it was active recently. Hooks only fire on activity,
so a purely time-based check made idle sessions vanish after two minutes. A PID
of `1` counts as dead: reparenting to init means the agent is gone.

**Design constraints,** which explain most of the behaviour:

- *Pointers, not payloads* — sessions exchange references and short digests, never transcripts. Hard token caps throughout.
- *Fail open* — switchboard being broken must never block your work. Errors are swallowed at the boundary and surfaced through `doctor`.
- *Warn, never deny* — a collision produces a warning, never a blocked edit.
- *Budget* — hooks run in a 500 ms budget. That's why `gitRoot` walks up for `.git` rather than spawning `git`.

---

## What it stores, and where

Everything lives in `.switchboard/` inside the repo, which `init` adds to
`.git/info/exclude`:

```
.switchboard/
  switchboard.db      SQLite: sessions, claims, digests, notes, refs, events
  ROSTER.md           plain-Markdown roster for agents without MCP
```

Stored per session: a short intent line, file paths opened and touched, commands
run, and notes explicitly posted. **Not** stored: prompts, model responses, or
transcripts.

Inspect exactly what's there before trusting it:

```bash
npx switchboard status --raw
```

---

## Privacy and security

**Nothing leaves your machine.** No network calls, no telemetry, no account. The
database is a local file.

**Secrets are redacted on write.** Digests are pattern-scanned before persisting
— GitHub tokens, `sk-` keys, AWS key shapes, `Bearer` tokens, PEM private key
headers. This is a safety net, not a guarantee: it's pattern matching, and it is
documented as imperfect. Don't rely on it to catch a novel credential format.

**Cross-session content is treated as untrusted.** Context injected from another
session is wrapped in an explicit envelope marking it as data, not instructions,
so one session's notes can't be used to steer another.

**Never commit `.switchboard/`.** It holds distilled session content — file
paths, commands, findings. `init` excludes it for you; the shipped `.gitignore`
covers `.switchboard/` and `*.db*` too.

---

## Troubleshooting

**"No sessions found" but sessions are clearly running.**
Run `npx switchboard doctor`. It surfaces `schemaError`, which is the usual
cause — a schema mismatch makes every write fail while fail-open hides the
error, so the tool looks healthy and returns nothing.

**Sessions disappear after a few minutes.**
Should not happen — liveness follows the process, not activity. If it does,
`doctor` will show whether PIDs are resolving.

**`/sbs` prints a list instead of an interactive picker.**
Either stdin isn't a TTY, or your build doesn't advertise MCP elicitation. The
numbered fallback accepts a number, a name, or a prefix. `npx switchboard sbs`
straight from the terminal always gets the arrow-key version.

**Config changes don't seem to apply.**
`init` compares content, not just file existence, so re-running it updates an
already-initialised repo. Run `npx switchboard init` again.

**`CLAUDE.md` is a symlink to `AGENTS.md`.**
Detected and handled — switchboard won't write a stanza that makes the file
import itself.

---

## Uninstalling

```bash
npx switchboard uninstall           # remove configs, keep data
npx switchboard uninstall --purge   # remove configs and data
npx switchboard purge               # drop data, keep configs
```

`uninstall` removes only what `init` wrote, including its `AGENTS.md` stanza
between the markers.

---

## Development

```bash
git clone https://github.com/swapnanilhoichoi/test.git switchboard
cd switchboard
node test/test.js      # 177 tests, no framework, no fixtures
```

Zero runtime dependencies and zero dev dependencies. The test suite is plain
`assert` with a small async-aware runner.

To develop against a local checkout, install with `--local` so configs point at
your working tree instead of `npx`:

```bash
node bin/switchboard.js init --local
```

Tests run against a `FAKE_HOME` with a snapshot guard asserting nothing is
written to your real home directory.

**Layout:**

```
bin/switchboard.js             CLI entrypoint
bin/switchboard-mcp.js         MCP server (stdio)
bin/switchboard-hook.js        hook receiver
bin/switchboard-statusline.js  status line renderer
src/store.js                   SQLite, migrations, liveness
src/core.js                    session registration, naming, mentions
src/digest.js                  digests, redaction, rendering
src/mcp.js                     JSON-RPC and the eight tools
src/hook.js                    per-agent hook dialects
src/installers.js              config writers for every agent
src/picker.js                  arrow-key TUI
src/workspace.js               workspace resolution, agent registry
```

Deeper design docs: [`switchboard-prd.md`](switchboard-prd.md) and
[`switchboard-compatibility-report.md`](switchboard-compatibility-report.md).

---

## License

MIT
