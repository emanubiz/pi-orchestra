# Hermes runtime nodes

How to run **Hermes TUI** agents on Orchestra nodes alongside **pi**.

> Implementation reference (completed): [plans/HERMES_TUI_IMPLEMENTATION_PLAN.md](../plans/HERMES_TUI_IMPLEMENTATION_PLAN.md)  
> Spike notes: [archive/HERMES_TUI_SPIKE_RESULT.md](../archive/HERMES_TUI_SPIKE_RESULT.md)

## Overview

Each graph node has an optional `runtime` field:

```typescript
runtime?: "pi" | "hermes";  // absent === "pi"
runtimeConfig?: { toolset?: string };  // non-secret; persisted in SQLite
```

- **pi** — `pi` CLI + `call-agent.ts` extension (default)
- **hermes** — `hermes --tui` in a PTY + `orchestra` plugin for handoff/watchdog

Mixed graphs (e.g. Architect on pi → Developer on Hermes) are supported.

## Availability

Hermes is **auto-detected**: if the `hermes` binary is on the **backend process**
PATH, nodes with `runtime: "hermes"` spawn `HermesRuntime`. The UI reads
`runtimes.hermes` from `/api/info`, `/api/health`, and the WebSocket `connected`
message.

When Hermes is not found, the UI disables or warns on the hermes option; nodes
that already have `runtime: "hermes"` **fall back to pi** at spawn time.

### Optional overrides

| Variable | Effect |
|----------|--------|
| *(unset)* | Auto-detect `hermes` on PATH (default) |
| `PINODES_ORCHESTRA_HERMES=false` | Force Hermes off even if installed |
| `PINODES_ORCHESTRA_HERMES=true` | Force Hermes on even if not on PATH (tests / special setups) |

> **Cursor / VS Code:** the backend inherits the IDE's PATH, not your interactive
> shell. If `hermes` works in a terminal but Orchestra says it's missing, restart
> the IDE from a terminal (`cursor .`) or add Hermes to a system-wide PATH.

## Requirements

**Just the Hermes CLI on PATH** (`hermes --version`). Everything else is
automatic.

The **orchestra plugin** ships with the app (`backend/hermes-plugins/orchestra/`,
bundled into the VSIX). The first time a Hermes node spawns,
`installHermesPlugin.ts` copies it into `~/.hermes/plugins/orchestra/` and runs
`hermes plugins enable orchestra` (both idempotent). No manual setup step — the
app is self-sufficient and depends on nothing beyond the Hermes binary.

> **Hermes ≥0.17 is opt-in:** a plugin under `~/.hermes/plugins/` isn't loaded
> until it's in `config.yaml`'s `plugins.enabled` list — which is exactly what
> the auto-install handles. If handoffs ever silently do nothing, confirm with
> `hermes plugins list` that `orchestra` shows **enabled**; a manual
> `hermes plugins enable orchestra` (or `bash scripts/setup-hermes-plugin.sh`
> for a dev symlink) is the fallback.

## UI: selecting runtime

Runtime is chosen **before** the node is created and **cannot be changed** in the UI afterward (the PTY spawns with that runtime on first attach).

1. Click **+ Add agent** in the Agents toolbar, or on the empty canvas
2. **Search or browse** prompts — **View** (eye icon) opens a read-only preview without creating a node
3. Select a prompt → **Next — choose runtime** → pick **pi** (default) or **hermes**
4. **Create agent node** — the card shows a read-only **pi** / **hm** badge

You can still change the node's **system prompt** (role) later via the Inspector or the scroll icon on the card; only runtime is fixed at creation.

If Hermes is selected but the CLI is not on the backend PATH, the runtime step shows a warning; the node falls back to pi at spawn time.

## How it works

| Concern | pi | Hermes |
|---------|----|--------|
| Spawn | `pi --tools … --extension call-agent.ts` | `hermes chat --tui -t …` |
| System prompt | `--system-prompt` + per-turn refresh via extension | `HERMES_EPHEMERAL_SYSTEM_PROMPT` env |
| Per-turn appendix (recipients, finality, kanban) | Refreshed into **system prompt** (`before_agent_start`) | Appended to **user message** via `pre_llm_call` — same info for the model, different slot |
| Handoff expression | `@@HANDOFF:handle … @@END` text block | **Same** `@@HANDOFF` text block |
| Where it's parsed | Extension on `agent_end` | Plugin `transform_llm_output` hook (also strips the block from the shown output) |
| Delivery to target node | `POST /internal/call-agent` → inject PTY | Same |
| Watchdog (non-final node must hand off) | Extension `before_agent_start` | Plugin → `POST /internal/turn-ended` → `PtyHub.handleTurnEnded` |
| Terminal rendering | xterm.js (ANSI) | xterm.js (identical) |

## Toolset override

Optional per-node:

```json
"runtimeConfig": { "toolset": "file,terminal,web" }
```

Use **Hermes** toolset names (`hermes tools list`): `file`, `terminal`, `web`,
`browser`, `code_execution`, … — **not** pi's `read,bash,edit,write,grep`.
Default when omitted: `file,terminal` (file ops + shell). pi nodes keep their own
default, `read,bash,edit,write,grep`. See [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md).

## Smoke test

```bash
bash scripts/setup-hermes-plugin.sh
node scripts/smoke.mjs
```

Manual checklist: [checklists/PRE_MERGE_TEST_CHECKLIST.md](../checklists/PRE_MERGE_TEST_CHECKLIST.md) §3–4.

## Related

- [HERMES_DESKTOP.md](./HERMES_DESKTOP.md) — embedding Orchestra inside Hermes Desktop (future host tab)
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — PtyHub, runtimes, handoff protocol
- [SECURITY.md](./SECURITY.md) — never put secrets in `runtimeConfig`
