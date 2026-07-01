# Pre-Merge Test Checklist — feat/multi-runtime

**Branch:** feat/multi-runtime
**Date:** 2026-07-XX (fill before testing)
**Tester:** ___________

> Quick sanity before merging into main. Each section takes ~2 minutes.
> Expected results are concrete — if you see something different, **stop and report**.

---

## 0. Quick Smoke (1 min)

```bash
node scripts/smoke.mjs
```

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Backend starts | `✅ Backend startup` |  |
| Board creation | `✅ POST /boards` |  |
| Graph load | `✅ PUT /graph` |  |
| Graph round-trip | `✅ GET /graph` |  |
| Status (idle) | `✅ GET /status` |  |
| Node CRUD | `✅ POST /nodes` + `POST /edges` |  |
| Cleanup | `✅ DELETE /boards` |  |

If `pi` is on PATH, also:
| Node run | `✅ POST /run` + status = running |  |

---

## 1. Regression: Pi Runtime (default) — 3 min

1. Open the UI (`http://localhost:3847`).
2. Create a board with cwd = a real project directory.
3. Add two nodes (Architect → Developer), wire an edge.
4. Click **Run** on the Architect node.

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Pi spawns | Terminal shows pi's prompt |  |
| Agent responds | Architect executes the task |  |
| Handoff | Architect hands off to Developer automatically |  |
| Developer runs | Developer terminal activates |  |
| Terminal output | Scrollback visible, no garbled characters |  |

---

## 2. Ring-Buffer Scrollback — 3 min

This tests that the ring buffer (256 KB cap) works correctly under heavy output.

1. In the running node's terminal, run a verbose command:
   ```bash
   for i in $(seq 1 100000); do echo "line $i"; done
   ```
2. While it's still running, **detach** (navigate away from the board).
3. Wait for the command to finish.
4. **Re-attach** by clicking the node card again.

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Output streams live | Lines appear in real-time |  |
| Detach + re-attach | Scrollback is replayed (last ~256 KB) |  |
| No crash | UI stays responsive during heavy output |  |
| No OOM | Memory doesn't balloon (ring buffer caps at 256 KB) |  |
| Buffer trimming | Oldest output is trimmed; latest is preserved |  |

**Bonus:** run `yes | head -n 500000` — the terminal should stay smooth.

---

## 3. Add-agent flow & runtime — 3 min

1. Open the board editor (empty or with nodes).
2. Click **+ Add agent** (Agents toolbar or empty-canvas button).

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Modal opens | Prompt list with search |  |
| View (eye) | Read-only preview; **no node spawned** |  |
| Custom prompt | Can create and continue to runtime step |  |
| Runtime step | pi default; hermes available when detected on the backend PATH |  |
| Create node | Node appears with correct prompt + runtime badge |  |
| Runtime locked | No pi/hm toggle on card or Inspector (badge only) |  |
| Graph persistence | After reload, runtime choice is preserved |  |
| Availability warning | If Hermes selected but not available on the backend, warning in runtime step |  |

> Note: Hermes won't actually spawn unless step 4 is configured.

---

## 4. Hermes Runtime Path — 3 min

### 4a. Plugin Auto-Install

No manual setup — the plugin installs itself on first Hermes spawn, and the
runtime is auto-detected when the `hermes` CLI is on the backend PATH. Only
force the flag if auto-detection can't see your install:

```bash
export PINODES_ORCHESTRA_HERMES=true   # optional override; auto-detect is the default
```

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Auto-copied | After first hermes spawn, `~/.hermes/plugins/orchestra/` exists (or is a dev symlink) |  |
| Auto-enabled | `hermes plugins list` shows `orchestra` **enabled** |  |
| Idempotent | Spawning more hermes nodes doesn't re-copy or error |  |

### 4b. Runtime Test

1. Restart the backend with `hermes` on its PATH (or `PINODES_ORCHESTRA_HERMES=true`).
2. Create a board, add a node with **runtime: hermes**.
3. Run it.

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Hermes spawns | Terminal shows hermes TUI (`hermes --tui`) |  |
| Plugin loads | No "plugin not found" errors in hermes output |  |
| Handoff works | Hermes node emits `@@HANDOFF … @@END`; delivered to a connected pi **or** hermes node |  |
| Handoff both ways | pi→hermes and hermes→pi both deliver (same text protocol) |  |
| Submit confirmed | A delivered task starts a turn in the recipient (watch disarmed; no "delivery may be stuck" error) |  |
| Stuck recovery | Disable the plugin (or block `/internal/turn-started`) so the recipient never confirms — the watch re-sends `\r` and recovers, or errors after 3 retries |  |

> If `hermes` is not installed, the node should exit gracefully (not crash the backend).

---

## 5. Edge Cases (optional, 2 min)

| Check | Expected | ✅/❌ |
|-------|----------|------|
| Self-loop rejected | UI/API returns error for a → a edge |  |
| Non-final node with no edges | Cannot save graph (validation error) |  |
| Delete running board | Board + terminals cleaned up |  |
| Auth token | Setting `PINODES_ORCHESTRA_TOKEN` blocks unauthenticated requests |  |

---

## Summary

| Area | Status |
|------|--------|
| Smoke test | ⬜ |
| Pi regression | ⬜ |
| Ring-buffer scrollback | ⬜ |
| Add-agent flow (prompt + runtime) | ⬜ |
| Hermes path | ⬜ |
| Edge cases | ⬜ |

**Decision:** ⬜ Ready to merge / ⬜ Blocker found (describe below)

**Notes / Blockers:**

```
(fill here)
```
