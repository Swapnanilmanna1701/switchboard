---
name: sbs
description: Browse, reference, continue, or message Switchboard sessions in the current repository. Use when the user invokes $sbs, asks to select or continue another AI session, or references an exact Switchboard session name.
---

<!-- switchboard:managed-codex-skill -->

# Switchboard sessions

Use the tools from the `switchboard` MCP server. Never invent, shorten, or
rewrite a session name. Copy the value labelled `Exact session name`
character-for-character.

Route the request as follows:

- Bare `$sbs`, browse, pick, or switch: call `sb_pick` with `all: true`.
  If it returns a selected session, use that context and continue its work. If
  the client cannot show the picker and the tool returns an index, show that
  index and wait for the user to choose; never choose for them.
- List live sessions: call `sb_peers`. List live and ended sessions: call
  `sb_peers` with `all: true`.
- Reference, inspect, compare with, or an `@<session-name>` mention: call
  `sb_session` with the exact name and use the returned context without
  changing the current session's identity.
- Continue or take over a named session: call `sb_attach` with the exact
  name. Set `adopt: true` only when the user explicitly asks to adopt claims;
  live-session claims must not be adopted.
- Message a session: call `sb_message` with the exact target and the user's
  text. Read messages with `sb_inbox`.

Do not pass `$sbs`, picker output, or Switchboard status text to `sb_name`.
For an ordinary substantive task, name the current session from the actual
task with `sb_name` if it does not already have a stable name.

If the Switchboard MCP server or required tools are unavailable, tell the user
to inspect `/mcp` and restart Codex after running Switchboard initialization.
