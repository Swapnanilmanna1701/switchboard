#!/usr/bin/env node
'use strict';
// The universal substrate entry point (ADR-0). Spawned once per agent session
// by any MCP client; its lifetime is the session's lifetime.
//
// Nothing may be written to stdout except JSON-RPC frames — stdout IS the
// transport. Diagnostics go to stderr.
require('../src/mcp').run({ cwd: process.cwd() });
