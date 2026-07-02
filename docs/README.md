# Documentation index

Ordered map of all project documentation. **Start here** if you are lost among roadmaps, plans, and reviews.

> **Language:** all documentation in this tree is **English**.

```
pinodes-orchestra/
├── README.md                          ← Quick start, config, prompt library
├── ARCHITECTURE.md                    ← Current system design (backend, runtimes, handoff)
├── prompts/*.md                       ← Built-in system prompt templates (29 roles)
└── docs/
    ├── README.md                      ← You are here
    │
    ├── guides/                        ← How it works today (operational)
    │   ├── SECURITY.md
    │   ├── PROGRAMMATIC_API.md
    │   ├── MULTI_INSTANCE.md
    │   ├── EXTENSION_PUBLISHING.md
    │   ├── HERMES_RUNTIME.md          ← Hermes nodes: setup, UI, flags
    │   ├── CLAUDE_RUNTIME.md          ← Claude Code nodes: setup, hooks, flags
    │   ├── CODEX_RUNTIME.md           ← Codex structured nodes: setup, config, smoke
    │   ├── HERMES_DESKTOP.md          ← Hermes Desktop host integration (future tab)
    │   ├── HERMES_CONTROL_PLANE.md   ← MCP server for Hermes control-plane access
    │   └── TEST_COVERAGE.md
    │
    ├── roadmaps/                      ← Where we are going (vision & sequencing)
    │   ├── EXTENSIONS_ROADMAP.md      ← Hosts (IDE, Hermes, OpenClaw) + runtimes
    │   └── EXPANSION_MOBILE_AND_PHYSICAL.md
    │
    ├── plans/                         ← Detailed implementation plans
    │   ├── CLAUDE_CODE_RUNTIME_PLAN.md         ✅ shipped (Claude Code runtime)
    │   ├── STRUCTURED_AGENT_RUNTIME_PLAN.md    🚧 Codex shipped; OpenCode/Zero deferred
    │   └── CURSOR_RUNTIME_ANALYSIS.md          ⏸️ deferred (feasibility study)
    │
    ├── checklists/
    │   └── PRE_MERGE_TEST_CHECKLIST.md
    │
    ├── archive/                       ← Completed plans, spikes & pre-build analysis (historical)
    │   ├── HERMES_TUI_IMPLEMENTATION_PLAN.md   ✅ completed (feat/multi-runtime)
    │   ├── HERMES_TUI_SPIKE_RESULT.md
    │   └── HERMES_TUI_IMPACT_ANALYSIS.md
    │
    └── reviews/                       ← Audit / review artifacts (point-in-time)
        ├── AUDIT_REVIEW_hermes-tui-runtime.md
        └── REVIEW_optimization_multi_harness.md
```

Also: [`vscode-extension/README.md`](../vscode-extension/README.md) — Cursor / VS Code extension.

---

## By audience

| I want to… | Read |
|------------|------|
| Run the app locally or in Cursor | [README.md](../README.md) |
| Understand backend + PTY + handoff | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Use Hermes agent nodes | [guides/HERMES_RUNTIME.md](./guides/HERMES_RUNTIME.md) |
| Use Codex structured nodes | [guides/CODEX_RUNTIME.md](./guides/CODEX_RUNTIME.md) |
| Connect Hermes to the MCP control plane | [guides/HERMES_CONTROL_PLANE.md](./guides/HERMES_CONTROL_PLANE.md) |
| Call boards/flows from CI or scripts | [guides/PROGRAMMATIC_API.md](./guides/PROGRAMMATIC_API.md) |
| Build or sideload the VSIX | [guides/EXTENSION_PUBLISHING.md](./guides/EXTENSION_PUBLISHING.md) |
| See what's shipped vs planned | [roadmaps/EXTENSIONS_ROADMAP.md](./roadmaps/EXTENSIONS_ROADMAP.md) |
| Pre-merge manual QA | [checklists/PRE_MERGE_TEST_CHECKLIST.md](./checklists/PRE_MERGE_TEST_CHECKLIST.md) |

---

## Current product status (2026-07)

| Area | Status |
|------|--------|
| Standalone web / PWA | ✅ Reference implementation |
| VS Code / Cursor / Windsurf extension | ✅ Published (Open VSX) |
| Multi-board, Kanban, Timeline | ✅ |
| Programmatic REST API | ✅ |
| Per-window backend isolation (extension) | ✅ |
| **pi runtime** (`runtime: "pi"`) | ✅ Default |
| **Hermes TUI runtime** (`runtime: "hermes"`) | ✅ Auto-detected when `hermes` on backend PATH |
| Add-agent flow (prompt picker + pre-spawn runtime) | ✅ + button, view-only preview, runtime locked after create |
| `runtimeConfig.toolset` | ✅ |
| **Claude Code runtime** (`runtime: "claude"`) | ✅ Shipped — [guides/CLAUDE_RUNTIME.md](./guides/CLAUDE_RUNTIME.md) |
| **Codex structured runtime** (`runtime: "codex"`) | ✅ Shipped — [guides/CODEX_RUNTIME.md](./guides/CODEX_RUNTIME.md) |
| Cursor Agent runtime | ⏸️ [plans/CURSOR_RUNTIME_ANALYSIS.md](./plans/CURSOR_RUNTIME_ANALYSIS.md) (deferred; use pi-as-proxy) |
| Hermes Desktop embedded tab | 🔜 Host-side work |
| OpenClaw integration | 🔜 |
| Mobile companion / physical runtime | 🔜 [roadmaps/EXPANSION_MOBILE_AND_PHYSICAL.md](./roadmaps/EXPANSION_MOBILE_AND_PHYSICAL.md) |
| Non-coding prompt library (research, writing, business, data) | ✅ 4 packs, 15 roles (29 built-ins total) |
| Closed-loop submit confirmation (`/internal/turn-started`) | ✅ See [ARCHITECTURE.md](../ARCHITECTURE.md) |

---

## Document lifecycle

| Folder | When to add here |
|--------|------------------|
| `guides/` | Describes **current** behavior users/operators rely on |
| `roadmaps/` | Multi-phase vision; update status columns as phases ship |
| `plans/` | Step-by-step implementation spec for a feature branch |
| `checklists/` | Repeatable QA / release gates |
| `archive/` | Spikes and pre-build analysis — **read-only** after feature ships |
| `reviews/` | Point-in-time audit/review; do not edit unless re-auditing |

When a plan is fully implemented, move it (and its supporting spikes) to `archive/` and mark it ✅ in this index.
