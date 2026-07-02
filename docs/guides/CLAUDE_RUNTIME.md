# Claude Code runtime nodes

How to run **Claude Code** agents on Orchestra nodes alongside **pi** and **Hermes**.

> Implementation plan: [plans/CLAUDE_CODE_RUNTIME_PLAN.md](../plans/CLAUDE_CODE_RUNTIME_PLAN.md)
> (v2, text-sentinel protocol). Status: **shipped on `main`** — optional manual QA:
> [checklist §4-C](../checklists/PRE_MERGE_TEST_CHECKLIST.md).

## Overview

```typescript
runtime?: "pi" | "hermes" | "claude";   // absent === "pi"
runtimeConfig?: { toolset?: string };   // non-secret; persisted in SQLite
```

- **claude** — interactive `claude` CLI in a PTY + a lifecycle **hook bridge**
  for orchestration. Mixed graphs (pi ↔ hermes ↔ claude) are supported; the
  handoff protocol is the same `@@HANDOFF` text standard everywhere.

## Availability

Auto-detected: if the `claude` binary is on the **backend process** PATH, nodes
with `runtime: "claude"` spawn `ClaudeRuntime`. The UI reads `runtimes.claude`
from `/api/info`, `/api/health`, and the WebSocket `connected` message.

When Claude Code is not found, the runtime selector warns and the node **falls
back to pi at spawn time** (same behavior as Hermes).

| Variable | Effect |
|----------|--------|
| *(unset)* | Auto-detect `claude` on PATH (default) |
| `PINODES_ORCHESTRA_CLAUDE=false` | Force off even if installed |
| `PINODES_ORCHESTRA_CLAUDE=true` | Force on even if not on PATH (tests) |

## Requirements

**Just the Claude Code CLI on PATH** (`claude --version`; developed against
2.1.198) with its own auth already configured (`claude` login or API key —
Orchestra never manages Claude credentials).

**Nothing is written to `~/.claude`.** The orchestra hooks are passed inline
per spawn via `--settings` (a JSON string), pointing at the bundled bridge
script `backend/claude-hooks/orchestra-hook.mjs`. The bridge **self-gates** on
`PINODES_ORCHESTRA_NODE`: your own `claude` sessions are never affected.

## How it works

| Concern | pi | Hermes | Claude Code |
|---------|----|--------|-------------|
| Spawn | `pi --tools … --extension call-agent.ts` | `hermes chat --tui -t …` | `claude --append-system-prompt … --settings <hooks> --allowedTools … --permission-mode acceptEdits` |
| System prompt | `--system-prompt` | `HERMES_EPHEMERAL_SYSTEM_PROMPT` env | `--append-system-prompt` |
| Per-turn appendix | system prompt (`before_agent_start`) | user message (`pre_llm_call`) | `additionalContext` (`UserPromptSubmit` hook) |
| Handoff expression | `@@HANDOFF:handle … @@END` | **same** | **same** |
| Where it's parsed | extension at `agent_end` | plugin `transform_llm_output` (strips sentinels) | hook bridge at `Stop` (reads the transcript; sentinels stay visible, as with pi) |
| Turn-started (submit confirmed) | `before_agent_start` | `pre_llm_call` (once/turn) | `UserPromptSubmit` |
| Turn-ended (node idle) | `agent_end` | `post_llm_call` | `Stop` |
| Watchdog (non-final must hand off) | client-side (`enforceIntent`) | **server-side nudge** | **server-side nudge** (`SERVER_NUDGED_RUNTIMES`) |
| Terminal rendering | xterm.js | xterm.js | xterm.js (identical) |

## Toolset override

Optional per-node, using **Claude's tool vocabulary** (capitalized — not pi's
`read,bash,…` nor Hermes' `file,terminal`):

```json
"runtimeConfig": { "toolset": "Read,Grep,Bash" }
```

Default when omitted: `Read,Edit,Write,Bash,Grep,Glob`. The list is passed as
`--allowedTools`, which pre-allows those tools so a pipeline node never blocks
on a permission prompt (no human sits at it).

## Closed-loop submit confirmation

Works out of the box: the `UserPromptSubmit` hook POSTs `/internal/turn-started`,
which is exactly the confirmation `PtyHub`'s submit watch expects. See
[ARCHITECTURE.md](../../ARCHITECTURE.md) § Closed-loop submit confirmation.

## Related

- [HERMES_RUNTIME.md](./HERMES_RUNTIME.md) — the sibling runtime this mirrors
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — PtyHub, runtimes, handoff protocol
- [SECURITY.md](./SECURITY.md) — never put secrets in `runtimeConfig`
