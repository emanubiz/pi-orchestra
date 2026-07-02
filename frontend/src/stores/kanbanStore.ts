import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  COLUMN_ALIASES,
  COLUMN_MIGRATION_MAP,
  KANBAN_COLUMNS,
  isValidColumn,
  type KanbanColumn,
  type KanbanColumnId,
} from "../constants/kanban";

// Re-export so existing consumers (e.g. useOrchestraWs) keep working.
export { KANBAN_COLUMNS, isValidColumn, type KanbanColumn, type KanbanColumnId };

/** Map free-form agent text to a column id (e.g. "in progress" → "in_progress"). */
export function normalizeColumn(raw: string): KanbanColumnId | null {
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (COLUMN_ALIASES[t]) return COLUMN_ALIASES[t];
  return isValidColumn(t) ? t : null;
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  column: KanbanColumnId;
  linkedBoardId: string | null;
  createdAt: number;
}

interface KanbanState {
  cards: KanbanCard[];
  addCard: (column: KanbanColumnId, title: string) => void;
  updateCard: (id: string, patch: Partial<Omit<KanbanCard, "id">>) => void;
  removeCard: (id: string) => void;
  moveCard: (id: string, column: KanbanColumnId) => void;
  /** Move the card linked to a board (most recent, not yet done) to a column. */
  moveCardByBoard: (boardId: string, column: KanbanColumnId) => void;
}

export const useKanbanStore = create<KanbanState>()(
  persist(
    (set) => ({
      cards: [],

      addCard: (column, title) =>
        set((s) => ({
          cards: [
            ...s.cards,
            {
              id: crypto.randomUUID(),
              title: title.trim() || "New card",
              description: "",
              column,
              linkedBoardId: null,
              createdAt: Date.now(),
            },
          ],
        })),

      updateCard: (id, patch) =>
        set((s) => ({
          cards: s.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        })),

      removeCard: (id) =>
        set((s) => ({ cards: s.cards.filter((c) => c.id !== id) })),

      moveCard: (id, column) =>
        set((s) => ({
          cards: s.cards.map((c) => (c.id === id ? { ...c, column } : c)),
        })),

      moveCardByBoard: (boardId, column) =>
        set((s) => {
          const candidates = s.cards
            .filter((c) => c.linkedBoardId === boardId && c.column !== "done")
            .sort((a, b) => b.createdAt - a.createdAt);
          const target = candidates[0] ?? s.cards.find((c) => c.linkedBoardId === boardId);
          if (!target) return s;
          return {
            cards: s.cards.map((c) => (c.id === target.id ? { ...c, column } : c)),
          };
        }),
    }),
    {
      name: "pinodes-orchestra-kanban",
      version: 2,
      migrate: (persisted: unknown) => {
        const state = persisted as { cards?: KanbanCard[] } | undefined;
        if (state?.cards) {
          state.cards = state.cards.map((c) => ({
            ...c,
            column: COLUMN_MIGRATION_MAP[c.column as string] ?? "todo",
          }));
        }
        return state as KanbanState;
      },
    },
  ),
);
