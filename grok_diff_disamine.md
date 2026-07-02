# Diff Analysis: release_0.3.0 vs main (as of 2026-07-02)

**Context**  
- Current branch: `release_0.3.0` (10 commits ahead of `main`)  
- Merge base: `682cf92` (HEAD of main at analysis time)  
- Direction analyzed: `main..release_0.3.0` (changes *introduced* by the release branch)  
- `git diff --shortstat`: **77 files changed, 4759 insertions(+), 615 deletions(-)**  
- Reverse diff (`release_0.3.0..main`) mostly shows deletions of the new mcp-server + codex assets.

## High-Level Summary

This branch brings two major feature sets that justify a 0.3.0 bump:

1. **Codex structured runtime** — a fourth backend runtime (headless/structured, using `codex exec --json`).
2. **MCP Control Plane** (`mcp-server`) — a thin MCP stdio server that exposes the Orchestra REST API to Hermes (and any MCP client).

It also includes supporting docs, frontend wiring, tests, smoke scripts, and some cleanup/refactoring.

The branch was built via feature merges:
- `feat: add Codex structured runtime (phases 1-4)`
- `feat: Codex runtime UX polish and docs (phases 5-6)`
- `Add Pinodes Orchestra MCP control plane`
- `feat: add workflow templates and refresh release docs`
- Merge commits + fixes/chore

## Key Additions & Changes

### 1. New Structured Runtime: Codex
**Core impl** (`backend/src/pty/runtime/`):
- `CodexRuntime.ts` (~320 LOC) — spawns `codex`, uses `--json` output, parses with `codexEventFormat.ts`
- `codexEventFormat.ts`, `codexAvailability.ts`
- `INodeRuntime.ts` generalized (now distinguishes `kind: "pty" | "structured"`)
- `PtyHub.ts` + tests updated for selection + hooks
- Sentinels moved/centralized in `backend/src/orchestra/sentinels.ts` (shared with pi/hermes/claude/codex)

**Frontend**:
- Runtime selector, badges, stores, App, FlowCanvas, NodeTerminal, WorkflowPicker updated to surface `codex`
- Types extended: `runtime?: "pi" | "hermes" | "claude" | "codex"`

**Docs & UX**:
- New `docs/guides/CODEX_RUNTIME.md` (excellent operator guide + example Architect→Codex Developer→Reviewer flow)
- Smoke scripts: `scripts/codex`, `scripts/codex-smoke.mjs`, `mock-codex.mjs`
- Extensive tests (`CodexRuntime.test.ts` 204 lines, availability, event format, etc.)
- Availability is auto-detected; **no fallback to `pi`** if `codex` CLI missing (explicit error in terminal)

**How it differs from PTY runtimes** (from ARCHITECTURE diff):
- PTY family (pi, hermes, claude): long-lived interactive process
- Structured (codex): per-inject `codex exec`, thread resume via ID, synthesized terminal output

### 2. MCP Server (Hermes Control Plane)
New workspace `mcp-server/` (21 files):
- `package.json`, tsconfig, vitest, src + tests
- Uses official `@modelcontextprotocol/sdk`
- Thin proxy: validates local policy (`ALLOWED_ROOTS`, audit for mutative ops) then forwards to `PINODES_ORCHESTRA_URL`
- Tools exposed (via REST mapping):
  - `orchestra_health`, `orchestra_info`
  - `orchestra_list_boards`, `orchestra_create_board`, `orchestra_get_graph`/`put_graph`
  - `orchestra_run_board`, `orchestra_get_status`, `orchestra_inject_node`
  - `orchestra_stop_board`, `orchestra_open_ui`
- Config: `PINODES_ORCHESTRA_MCP_MODE=safe` (prevents direct browser open), audit logging (`mcp-audit.jsonl`)
- `mcp-server/test/tools-mutative.test.ts` etc.

Docs:
- `docs/guides/HERMES_CONTROL_PLANE.md`
- Large active plan: `docs/plans/HERMES_CONTROL_PLANE_PLAN.md` (consolidates control-plane first, defers desktop tab to thin host)
- Roadmap and other docs refreshed; old plans archived (`docs/archive/`)

**Root changes**:
- `package.json` workspaces now include `"mcp-server"`
- `package-lock.json` massive churn (expected)
- Minor updates in `backend/src/index.ts`, routes, ws/handler, types

### 3. Documentation & Housekeeping
- `ARCHITECTURE.md` updated with 4-runtime diagram + structured vs PTY table + Codex section
- `docs/roadmaps/EXTENSIONS_ROADMAP.md` rewritten (MCP first → Desktop → later)
- `CHANGELOG.md` bumped to 0.2.23 (unreleased) — still mostly Claude/Hermes docs; **Codex + MCP not yet described in detail here**
- `AGENTS.md`, `README.md`, `CLAUDE.md`, `docs/README.md`, `PRE_MERGE_TEST_CHECKLIST.md` touched
- Workflow templates feature + docs
- Old plans moved to archive (Cursor, Zero runtime, etc.)

## What I Think (Opinions & Assessment)

### Strengths (positive)
- **Excellent architectural consistency**. Codex follows the exact same sentinel/handoff pattern as the previous Claude addition. The `INodeRuntime` + `kind` split cleanly separates concerns. This shows the multi-runtime abstraction is maturing.
- **MCP is the right integration point**. Instead of forking or embedding, exposing a controlled REST surface via standard MCP is clean, auditable, and works from CLI/TUI/Desktop equally. The safety layer (roots + audit + safe mode) is responsible.
- **Documentation quality is high**. The new guides (especially CODEX_RUNTIME + the control-plane plan) are operator-first, have examples, smoke checklists, and clear "why this shape" rationale. Rare for internal projects.
- **Testing & probes**. Availability checks + dedicated tests + smoke wrappers for the new external CLIs are good engineering hygiene.
- **Phased development visible** in commits (phases 1-4, 5-6, separate MCP merge). Good discipline.
- **Workflow templates** addition hints at higher-level UX for common patterns (architect/developer/reviewer etc.).

### Concerns & Risks
- **Runtime explosion**. We now have 4 runtimes (pi + hermes + claude + codex). Each external CLI (`claude`, `codex`, `hermes`) brings its own fragility (output format changes, auth, PATH issues, platform quirks). The "no fallback" policy for codex is correct but will surprise users. The selector and type unions will keep growing.
- **Changelog lag**. The monorepo CHANGELOG and especially `vscode-extension/CHANGELOG.md` (the published one) do not yet reflect Codex or the MCP server. For a 0.3.0 release this is important.
- **MCP server maturity**. It's a new workspace with its own tests. The audit is only for a subset of tools; the proxy trusts the backend once roots pass. Consider rate limiting, better error mapping, and versioning of the MCP tool surface.
- **Structured vs PTY divergence**. Codex doesn't maintain a live PTY, so keyboard input is disabled and UX differs. This is documented, but long-term users may expect uniform behavior. The synthesized terminal output must stay faithful.
- **Package/workspace impact**. Adding a workspace + huge lockfile diff is normal but means release process, CI, and VSIX bundling may need updates (check if mcp-server is bundled or published separately).
- **Git history**. Several "merge: XXX into release_0.3.0" commits. If this is squash-merged later it might be ok, but keep linear history or use proper merge commits if you want traceability.
- **Codex-specific**: relies on `codex` CLI (presumably OpenAI's or similar agent). The json parsing + thread resume logic is new surface for bugs. The smoke wrapper portability fix in the last commit is a good sign they caught some issues.

### Neutral / Observations
- Root `package.json` version still at 0.1.0 (the real versioning lives in the extension and perhaps backend). Make sure 0.3.0 bump happens in the right places.
- Some files were moved to `docs/archive/` — good decluttering, but verify links in remaining docs.
- The branch is purely additive in spirit (big net +LOC).

## Recommendations Before Merging / Releasing as 0.3.0

1. **Update changelogs thoroughly** — both root and `vscode-extension/CHANGELOG.md`. Add sections for Codex and MCP server.
2. **Run the full verify script** (from AGENTS.md):
   ```bash
   npm test --workspaces --if-present
   npx tsc --noEmit -p backend
   npx tsc --noEmit -p frontend
   npx tsc --noEmit -p vscode-extension
   npm run build
   cd vscode-extension && npx vitest run
   ```
3. **MCP integration test**: actually register it with a local Hermes and exercise `orchestra_create_board` + run + inject from Hermes.
4. **Codex smoke**: confirm on a real `codex` install (or the mock). Test handoff chains, resumeThreadId, sandbox modes.
5. **Consider a small "runtimes matrix" doc** or table that lists for each runtime: PTY/structured, long-lived?, input support, tool translation, fallback behavior, auth.
6. **Audit coverage**: expand mutative audit logging if possible; add non-mutative audit for visibility if desired.
7. **Versioning**: decide if `mcp-server` gets its own version or stays in sync with the monorepo.
8. **GitNexus impact**: before final merge, consider running GitNexus `detect_changes` + impact on key symbols (`CodexRuntime`, `INodeRuntime`, board tools, etc.) as per project instructions.
9. **Deprecate or clearly label** the older Claude plan docs if they are now superseded.

## Bottom Line

This is a **substantial, well-structured increment**. The team is successfully generalizing the runtime abstraction and opening a proper control surface for Hermes via MCP — exactly the right direction for "orchestrating orchestrators".

Codex feels like a natural next structured runtime after Claude. The MCP piece is the more strategic addition for the 0.3 series.

**Risk level**: Medium. Mostly additive, good tests and docs, but external CLI dependencies + growing runtime surface require care. With changelog updates + full test/build pass, this looks merge-ready for a 0.3.0 milestone.

If the goal of 0.3.0 is "multi-structured-runtimes + Hermes control plane", this branch delivers it cleanly.

---

*Analysis generated by exploring `git diff main..release_0.3.0`, commit logs, key source files, and docs on 2026-07-02. Current branch at analysis: release_0.3.0.*
