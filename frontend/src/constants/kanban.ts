/**
 * Kanban column definitions — single source of truth.
 *
 * Every consumer (store, migration, UI, validation) should derive its
 * column knowledge from this file so that adding or renaming a column
 * requires touching exactly one place.
 */

// ── Column type ─────────────────────────────────────────────────────────────

export type KanbanColumnId = "todo" | "in_progress" | "test" | "review" | "done";

// ── Column registry ─────────────────────────────────────────────────────────

export interface KanbanColumn {
  id: KanbanColumnId;
  label: string;
}

/** Canonical column list (display order in the UI). */
export const KANBAN_COLUMNS: KanbanColumn[] = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "test", label: "Test" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** Fast lookup set of valid column ids. */
export const COLUMN_IDS: ReadonlySet<KanbanColumnId> = new Set(
  KANBAN_COLUMNS.map((c) => c.id),
);

// ── Aliases (agent text → canonical id) ─────────────────────────────────────

/**
 * Map of free-form strings to canonical column ids.
 * Used by {@link normalizeColumn} to translate agent-produced text
 * (e.g. "in progress", "QA", "WIP") into a valid column id.
 *
 * Keys should be lowercase with underscores (the normalizer applies
 * `.toLowerCase().replace(/[\s-]+/g, "_")` before lookup).
 */
export const COLUMN_ALIASES: Readonly<Record<string, KanbanColumnId>> = {
  todo: "todo",
  to_do: "todo",
  backlog: "todo",
  in_progress: "in_progress",
  inprogress: "in_progress",
  doing: "in_progress",
  wip: "in_progress",
  test: "test",
  testing: "test",
  qa: "test",
  review: "review",
  reviewing: "review",
  done: "done",
  completed: "done",
};

// ── Migration (legacy persisted value → canonical id) ───────────────────────

/**
 * Map of legacy column ids that existed in earlier persisted state versions.
 * Used by the zustand-persist `migrate` function to upgrade old localStorage.
 *
 * Keep this separate from {@link COLUMN_ALIASES} — aliases normalize
 * *agent input* (many-to-one, ongoing), while this map upgrades
 * *persisted data* (versioned, run-once).
 */
export const COLUMN_MIGRATION_MAP: Readonly<Record<string, KanbanColumnId>> = {
  backlog: "todo",
  todo: "todo",
  doing: "in_progress",
  in_progress: "in_progress",
  test: "test",
  review: "review",
  done: "done",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check whether a string is a valid column id. */
export function isValidColumn(id: string): id is KanbanColumnId {
  return COLUMN_IDS.has(id as KanbanColumnId);
}
