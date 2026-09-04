# AGENTS.md

<!-- switchboard:begin -->
## Concurrent sessions

Other AI sessions may be working in this repo right now.
Before starting a task, call `sb_inbox` and `sb_peers` (MCP) — or read
`.switchboard/ROSTER.md` — to see what they're doing and which
files they've claimed. Post findings with `sb_note`.

After the first substantive user request, call `sb_name` with a short
action-and-subject summary of the actual task. Do not use slash-command output
or Switchboard status text as the task. Hook-capable agents may already have a
proper name; in that case `sb_name` simply returns it.

Every session entry labels its `Exact session name`, e.g. `fix-auth-tokens`.

- If the user writes `@<session-name>`, they are referring to that session:
  copy the exact name after `@` character-for-character, call `sb_session`
  with that exact name, and use what it returns. Never shorten, rewrite, or
  substitute the session description for the name.
- To continue another session's work, call `sb_attach` with its name.
<!-- switchboard:end -->
