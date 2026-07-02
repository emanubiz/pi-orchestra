# Codex Structured Runtime

PiNodes Orchestra can back a node with **Codex** as a structured (headless) runtime instead of an interactive PTY.

## Requirements

- `codex` CLI on the **backend process** PATH (same machine that runs `pinodes-orchestra`)
- Codex authenticated (`codex login` or `CODEX_API_KEY` for `codex exec`)

## Enable

Availability is detected automatically. Override with:

```bash
PINODES_ORCHESTRA_CODEX=true   # force on (tests)
PINODES_ORCHESTRA_CODEX=false  # force off
```

When Codex is unavailable, nodes with `runtime: "codex"` **do not** fall back to pi — they fail with a clear terminal error.

## Node configuration

Set `runtime: "codex"` on a workflow node. Optional non-secret `runtimeConfig` fields:

| Field | Values | Default |
|-------|--------|---------|
| `model` | Codex model id | CLI default |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | `workspace-write` |
| `approvalMode` | `untrusted`, `on-request`, `never` | `on-request` |
| `profile` | Codex profile name | — |
| `resumeThreadId` | Existing Codex thread id | fresh thread per node |

Never store API keys or tokens in `runtimeConfig` — it is persisted to SQLite and sent to the browser.

## How it works

1. **spawn** — prepares the node session (no model work yet), emits `─ codex session ready ─`
2. **inject** — runs `codex exec --json` (or `codex exec resume <thread> --json` for follow-ups)
3. JSONL events are converted to terminal-safe output in the node panel
4. Handoffs use the same sentinels as pi/Hermes/Claude: `@@HANDOFF`, `@@CARD`, `@@DONE`

## UI behavior

Structured nodes render output in the terminal panel, but **keyboard input is disabled**
— use **Run** or programmatic inject to send tasks. The side panel shows a hint when a
Codex node is selected.

## Example flow: Architect → Codex Developer → Reviewer

1. Create a board with cwd set to your repo.
2. Add three nodes:
   - **Architect** — `runtime: pi` (or any runtime), prompt `builtin-architect`
   - **Developer** — `runtime: codex`, prompt `builtin-developer`, `canBeFinal: false`
   - **Reviewer** — `runtime: pi`, prompt `builtin-architect-reviewer`
3. Wire edges: Architect → Developer → Reviewer.
4. Set Architect as entry node; run with a task like "Design and implement feature X".
5. Architect hands off to the Codex Developer node via `@@HANDOFF`.
6. Codex implements in `workspace-write` sandbox and hands off to Reviewer.
7. Reviewer completes the chain with `@@DONE` or further handoffs.

REST equivalent (abbreviated):

```bash
curl -X POST "$BASE/api/v1/orchestra/boards/$BOARD/nodes" -H "Content-Type: application/json" \
  -d '{"id":"dev","label":"Developer","promptId":"builtin-developer","runtime":"codex","canBeFinal":false,"position":{"x":200,"y":0}}'
```

## Smoke checklist

1. Confirm `/api/info` shows `runtimes.codex: true`
2. Create a board with `Architect → Codex Developer → Reviewer`
3. Run the entry node; confirm the Codex node receives the handoff
4. Confirm Codex output appears in the terminal panel
5. Confirm Codex can hand off downstream
6. Restart the Codex node and verify a fresh session (unless `resumeThreadId` is set)
