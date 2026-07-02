# Documentation index

Ordered map of project documentation. **Start here** if you are lost.

> **Language:** all documentation in this tree is **English**.
> **Rule:** keep `plans/` for active implementation plans only. Feasibility studies and shipped plans go to `archive/`.

```text
pinodes-orchestra/
├── README.md                          ← Quick start, config, prompt library
├── ARCHITECTURE.md                    ← Current system design: backend, runtimes, handoff
├── prompts/*.md                       ← Built-in system prompt templates (29 roles)
└── docs/
    ├── README.md                      ← You are here
    │
    ├── guides/                        ← Current operational behaviour
    │   ├── SECURITY.md
    │   ├── PROGRAMMATIC_API.md
    │   ├── MULTI_INSTANCE.md
    │   ├── EXTENSION_PUBLISHING.md
    │   ├── HERMES_RUNTIME.md
    │   ├── CLAUDE_RUNTIME.md
    │   ├── CODEX_RUNTIME.md
    │   ├── HERMES_CONTROL_PLANE.md    ← MCP server for Hermes control-plane access
    │   ├── HERMES_DESKTOP.md          ← Short operator guide; implementation lives in plan
    │   └── TEST_COVERAGE.md
    │
    ├── plans/                         ← Active implementation plans only
    │   └── HERMES_CONTROL_PLANE_PLAN.md ← Hermes MCP control-plane + Desktop tab
    │
    ├── roadmaps/                      ← High-level sequencing / long horizon
    │   ├── EXTENSIONS_ROADMAP.md
    │   └── EXPANSION_MOBILE_AND_PHYSICAL.md
    │
    ├── checklists/
    │   └── PRE_MERGE_TEST_CHECKLIST.md
    │
    ├── archive/                       ← Shipped/deferred/historical analysis
    │   ├── CLAUDE_CODE_RUNTIME_PLAN.md         ✅ shipped
    │   ├── HERMES_TUI_IMPLEMENTATION_PLAN.md   ✅ shipped
    │   ├── HERMES_TUI_SPIKE_RESULT.md
    │   ├── HERMES_TUI_IMPACT_ANALYSIS.md
    │   ├── CURSOR_RUNTIME_ANALYSIS.md          ⏸️ deferred
    │   └── ZERO_RUNTIME_ANALYSIS.md            ❌ not viable today
    │
    └── reviews/                       ← Point-in-time audits/reviews
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
| Use Claude Code nodes | [guides/CLAUDE_RUNTIME.md](./guides/CLAUDE_RUNTIME.md) |
| Use Codex structured nodes | [guides/CODEX_RUNTIME.md](./guides/CODEX_RUNTIME.md) |
| Connect Hermes to the MCP control plane | [guides/HERMES_CONTROL_PLANE.md](./guides/HERMES_CONTROL_PLANE.md) |
| Let Hermes control Orchestra via MCP / plan the Desktop tab | [plans/HERMES_CONTROL_PLANE_PLAN.md](./plans/HERMES_CONTROL_PLANE_PLAN.md) |
| Embed Orchestra in Hermes Desktop | [guides/HERMES_DESKTOP.md](./guides/HERMES_DESKTOP.md) + [plans/HERMES_CONTROL_PLANE_PLAN.md](./plans/HERMES_CONTROL_PLANE_PLAN.md) |
| Call boards/flows from CI, scripts, MCP, or hosts | [guides/PROGRAMMATIC_API.md](./guides/PROGRAMMATIC_API.md) |
| Build or sideload the VSIX | [guides/EXTENSION_PUBLISHING.md](./guides/EXTENSION_PUBLISHING.md) |
| See host/runtime sequencing | [roadmaps/EXTENSIONS_ROADMAP.md](./roadmaps/EXTENSIONS_ROADMAP.md) |
| See mobile/physical long-horizon ideas | [roadmaps/EXPANSION_MOBILE_AND_PHYSICAL.md](./roadmaps/EXPANSION_MOBILE_AND_PHYSICAL.md) |
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
| **Hermes TUI runtime** (`runtime: "hermes"`) | ✅ Auto-detected when `hermes` is on backend PATH |
| **Claude Code runtime** (`runtime: "claude"`) | ✅ Shipped — [guides/CLAUDE_RUNTIME.md](./guides/CLAUDE_RUNTIME.md) |
| **Codex structured runtime** (`runtime: "codex"`) | ✅ Shipped — [guides/CODEX_RUNTIME.md](./guides/CODEX_RUNTIME.md) |
| Add-agent flow + `runtimeConfig.toolset` | ✅ |
| Hermes MCP control-plane | 🔜 Active plan — [HERMES_CONTROL_PLANE_PLAN.md](./plans/HERMES_CONTROL_PLANE_PLAN.md) |
| Hermes Desktop embedded tab | 🔜 Planned as thin host after MCP/control-plane |
| Cursor Agent native runtime | ⏸️ Deferred; use VS Code extension in Cursor or pi-as-proxy. Archived analysis: [archive/CURSOR_RUNTIME_ANALYSIS.md](./archive/CURSOR_RUNTIME_ANALYSIS.md) |
| Zero runtime | ❌ Not viable via PTY today; archived analysis: [archive/ZERO_RUNTIME_ANALYSIS.md](./archive/ZERO_RUNTIME_ANALYSIS.md) |
| OpenClaw integration | 🔜 |
| Mobile companion / physical runtime | 🔜 [roadmaps/EXPANSION_MOBILE_AND_PHYSICAL.md](./roadmaps/EXPANSION_MOBILE_AND_PHYSICAL.md) |
| Non-coding prompt library | ✅ 4 packs, 15 roles (29 built-ins total) |
| Closed-loop submit confirmation (`/internal/turn-started`) | ✅ See [ARCHITECTURE.md](../ARCHITECTURE.md) |

---

## Document lifecycle

| Folder | When to add here |
|--------|------------------|
| `guides/` | Describes **current** behaviour users/operators rely on. |
| `plans/` | Active implementation plans with clear owner/next action. Keep this small. |
| `roadmaps/` | Multi-phase vision and sequencing; no implementation detail dumps. |
| `checklists/` | Repeatable QA / release gates. |
| `archive/` | Shipped plans, spikes, feasibility studies, rejected/deferred analyses. |
| `reviews/` | Point-in-time audit/review artifacts; do not edit unless re-auditing. |

When a plan ships or gets deferred, move it to `archive/` and keep only a short pointer in the relevant roadmap/status table.
