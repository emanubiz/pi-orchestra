import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardRow, BoardState, SystemPromptRow, WorkflowGraph } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PINODES_ORCHESTRA_ROOT: bundled assets (prompts). Defaults to repo root.
const ROOT = process.env.PINODES_ORCHESTRA_ROOT
  ? path.resolve(process.env.PINODES_ORCHESTRA_ROOT)
  : path.resolve(__dirname, "../../..");
// PINODES_ORCHESTRA_DATA_DIR: writable SQLite location. Defaults to <root>/data.
const DATA_DIR = process.env.PINODES_ORCHESTRA_DATA_DIR
  ? path.resolve(process.env.PINODES_ORCHESTRA_DATA_DIR)
  : path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "pinodes-orchestra.db");
const PROMPTS_DIR = path.join(ROOT, "prompts");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema();
    seedPrompts();
  }
  return db;
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      graph_data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      label TEXT NOT NULL,
      graph_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: drop the legacy `emoji` column from older databases.
  const hasEmoji = (
    db.prepare("PRAGMA table_info(system_prompts)").all() as { name: string }[]
  ).some((c) => c.name === "emoji");
  if (hasEmoji) db.exec("ALTER TABLE system_prompts DROP COLUMN emoji");
}

function seedPrompts(): void {
  const builtins = [
    { id: "builtin-pm", name: "Project Manager", file: "project-manager.md" },
    { id: "builtin-po", name: "Product Owner", file: "product-owner.md" },
    { id: "builtin-architect", name: "Architect", file: "architect.md" },
    { id: "builtin-ux", name: "UX/UI Designer", file: "ux-designer.md" },
    { id: "builtin-developer", name: "Developer", file: "developer.md" },
    { id: "builtin-backend", name: "Backend Developer", file: "backend-developer.md" },
    { id: "builtin-frontend", name: "Frontend Developer", file: "frontend-developer.md" },
    { id: "builtin-devops", name: "DevOps", file: "devops.md" },
    { id: "builtin-qa", name: "QA Engineer", file: "qa.md" },
    { id: "builtin-auditor", name: "Auditor", file: "auditor.md" },
    { id: "builtin-arch-reviewer", name: "Architectural Reviewer", file: "architectural-reviewer.md" },
    { id: "builtin-design-reviewer", name: "Design Reviewer", file: "design-reviewer.md" },
    { id: "builtin-security-reviewer", name: "Security Reviewer", file: "security-reviewer.md" },
    { id: "builtin-writer", name: "Technical Writer", file: "tech-writer.md" },

    // ── Research & Analysis pipeline (non-coding) ──
    { id: "builtin-researcher", name: "Researcher", file: "researcher.md" },
    { id: "builtin-fact-checker", name: "Fact-Checker", file: "fact-checker.md" },
    { id: "builtin-analyst", name: "Analyst", file: "analyst.md" },
    { id: "builtin-research-editor", name: "Research Editor", file: "research-editor.md" },

    // ── Content & Writing pipeline (non-coding) ──
    { id: "builtin-content-strategist", name: "Content Strategist", file: "content-strategist.md" },
    { id: "builtin-content-writer", name: "Writer", file: "writer.md" },
    { id: "builtin-copy-editor", name: "Copy Editor", file: "copy-editor.md" },
    { id: "builtin-proofreader-seo", name: "Proofreader & SEO", file: "proofreader-seo.md" },

    // ── Business & Strategy pipeline (non-coding) ──
    { id: "builtin-market-analyst", name: "Market Analyst", file: "market-analyst.md" },
    { id: "builtin-strategist", name: "Business Strategist", file: "strategist.md" },
    { id: "builtin-financial-modeler", name: "Financial Modeler", file: "financial-modeler.md" },
    { id: "builtin-strategy-reviewer", name: "Strategy Reviewer", file: "strategy-reviewer.md" },

    // ── Data & Insights pipeline (non-coding) ──
    { id: "builtin-data-analyst", name: "Data Analyst", file: "data-analyst.md" },
    { id: "builtin-statistician", name: "Statistician", file: "statistician.md" },
    { id: "builtin-report-writer", name: "Report Writer", file: "report-writer.md" },
  ];

  // UPSERT so builtin refinements + new roles stay in sync with the .md files.
  const insert = db.prepare(`
    INSERT INTO system_prompts (id, name, content, is_builtin)
    VALUES (@id, @name, @content, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      content = excluded.content,
      updated_at = datetime('now')
  `);

  for (const b of builtins) {
    const filePath = path.join(PROMPTS_DIR, b.file);
    if (!fs.existsSync(filePath)) continue;
    insert.run({
      id: b.id,
      name: b.name,
      content: fs.readFileSync(filePath, "utf-8"),
    });
  }
}

export function listPrompts(): SystemPromptRow[] {
  return getDb()
    .prepare("SELECT * FROM system_prompts ORDER BY is_builtin DESC, name ASC")
    .all() as SystemPromptRow[];
}

export function getPrompt(id: string): SystemPromptRow | undefined {
  return getDb()
    .prepare("SELECT * FROM system_prompts WHERE id = ?")
    .get(id) as SystemPromptRow | undefined;
}

export function createPrompt(
  id: string,
  name: string,
  content: string,
): SystemPromptRow {
  getDb()
    .prepare(
      `INSERT INTO system_prompts (id, name, content, is_builtin)
       VALUES (?, ?, ?, 0)`,
    )
    .run(id, name, content);
  return getPrompt(id)!;
}

export function updatePrompt(
  id: string,
  name: string,
  content: string,
): SystemPromptRow | undefined {
  const existing = getPrompt(id);
  if (!existing) return undefined;
  getDb()
    .prepare(
      `UPDATE system_prompts SET name=?, content=?, updated_at=datetime('now') WHERE id=?`,
    )
    .run(name, content, id);
  return getPrompt(id);
}

export function deletePrompt(id: string): boolean {
  const existing = getPrompt(id);
  if (!existing || existing.is_builtin) return false;
  getDb().prepare("DELETE FROM system_prompts WHERE id = ?").run(id);
  return true;
}

export function listWorkflows(): { id: string; name: string; updated_at: string }[] {
  return getDb()
    .prepare("SELECT id, name, updated_at FROM workflows ORDER BY updated_at DESC")
    .all() as { id: string; name: string; updated_at: string }[];
}

export function getWorkflow(id: string): WorkflowGraph | undefined {
  const row = getDb()
    .prepare("SELECT graph_data FROM workflows WHERE id = ?")
    .get(id) as { graph_data: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.graph_data) as WorkflowGraph;
}

export function saveWorkflow(graph: WorkflowGraph): WorkflowGraph {
  const id = graph.id ?? crypto.randomUUID();
  const payload = JSON.stringify({ ...graph, id });
  getDb()
    .prepare(
      `INSERT INTO workflows (id, name, graph_data) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, graph_data=excluded.graph_data, updated_at=datetime('now')`,
    )
    .run(id, graph.name, payload);
  return getWorkflow(id)!;
}

export function deleteWorkflow(id: string): boolean {
  const r = getDb().prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return r.changes > 0;
}

function boardRowToState(row: BoardRow): BoardState {
  return {
    boardId: row.id,
    cwd: row.cwd,
    label: row.label,
    graph: row.graph_data ? (JSON.parse(row.graph_data) as WorkflowGraph) : undefined,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export function createBoard(id: string, cwd: string, label: string): BoardState {
  const name = label ?? cwd.split("/").filter(Boolean).pop() ?? "board";
  getDb()
    .prepare(
      `INSERT INTO boards (id, cwd, label) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, label=excluded.label, updated_at=datetime('now')`,
    )
    .run(id, cwd, name);
  return getBoard(id)!;
}

export function listBoards(): BoardState[] {
  const rows = getDb()
    .prepare("SELECT * FROM boards ORDER BY updated_at DESC")
    .all() as BoardRow[];
  return rows.map(boardRowToState);
}

export function getBoard(id: string): BoardState | undefined {
  const row = getDb().prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
  if (!row) return undefined;
  return boardRowToState(row);
}

export function saveBoardGraph(id: string, graph: WorkflowGraph): BoardState | undefined {
  const existing = getBoard(id);
  if (!existing) return undefined;
  getDb()
    .prepare(
      `UPDATE boards SET graph_data = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(JSON.stringify(graph), id);
  return getBoard(id)!;
}

export function deleteBoard(id: string): boolean {
  const r = getDb().prepare("DELETE FROM boards WHERE id = ?").run(id);
  return r.changes > 0;
}
