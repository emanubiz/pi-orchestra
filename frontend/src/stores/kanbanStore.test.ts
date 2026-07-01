import { describe, it, expect, beforeEach } from "vitest";
import { normalizeColumn, useKanbanStore, type KanbanCard } from "./kanbanStore";

describe("normalizeColumn", () => {
  it("maps known aliases to their canonical column id", () => {
    expect(normalizeColumn("todo")).toBe("todo");
    expect(normalizeColumn("to do")).toBe("todo");
    expect(normalizeColumn("backlog")).toBe("todo");
    expect(normalizeColumn("in progress")).toBe("in_progress");
    expect(normalizeColumn("inprogress")).toBe("in_progress");
    expect(normalizeColumn("doing")).toBe("in_progress");
    expect(normalizeColumn("WIP")).toBe("in_progress");
    expect(normalizeColumn("Testing")).toBe("test");
    expect(normalizeColumn("qa")).toBe("test");
    expect(normalizeColumn("Review")).toBe("review");
    expect(normalizeColumn("reviewing")).toBe("review");
    expect(normalizeColumn("Completed")).toBe("done");
  });

  it("accepts a canonical column id verbatim", () => {
    expect(normalizeColumn("in_progress")).toBe("in_progress");
  });

  it("is case- and whitespace-insensitive and tolerates dashes", () => {
    expect(normalizeColumn("  In-Progress  ")).toBe("in_progress");
  });

  it("returns null for unrecognized text", () => {
    expect(normalizeColumn("blocked")).toBeNull();
    expect(normalizeColumn("")).toBeNull();
  });
});

describe("kanbanStore — card CRUD", () => {
  beforeEach(() => {
    useKanbanStore.setState({ cards: [] });
  });

  it("addCard trims the title and defaults an empty one", () => {
    useKanbanStore.getState().addCard("todo", "  Fix the bug  ");
    useKanbanStore.getState().addCard("todo", "   ");

    const cards = useKanbanStore.getState().cards;
    expect(cards[0]).toMatchObject({ title: "Fix the bug", column: "todo", linkedBoardId: null });
    expect(cards[1]).toMatchObject({ title: "New card" });
  });

  it("updateCard patches only the targeted card", () => {
    useKanbanStore.getState().addCard("todo", "A");
    useKanbanStore.getState().addCard("todo", "B");
    const [a, b] = useKanbanStore.getState().cards;

    useKanbanStore.getState().updateCard(a.id, { description: "details" });

    const cards = useKanbanStore.getState().cards;
    expect(cards.find((c) => c.id === a.id)?.description).toBe("details");
    expect(cards.find((c) => c.id === b.id)?.description).toBe("");
  });

  it("removeCard drops only the targeted card", () => {
    useKanbanStore.getState().addCard("todo", "A");
    useKanbanStore.getState().addCard("todo", "B");
    const [a] = useKanbanStore.getState().cards;

    useKanbanStore.getState().removeCard(a.id);

    expect(useKanbanStore.getState().cards).toHaveLength(1);
    expect(useKanbanStore.getState().cards[0].title).toBe("B");
  });

  it("moveCard changes only the targeted card's column", () => {
    useKanbanStore.getState().addCard("todo", "A");
    const [a] = useKanbanStore.getState().cards;

    useKanbanStore.getState().moveCard(a.id, "review");

    expect(useKanbanStore.getState().cards[0].column).toBe("review");
  });
});

describe("kanbanStore — moveCardByBoard", () => {
  beforeEach(() => {
    useKanbanStore.setState({ cards: [] });
  });

  function seed(cards: Array<Partial<KanbanCard> & { id: string }>) {
    useKanbanStore.setState({
      cards: cards.map((c) => ({
        title: "t",
        description: "",
        column: "todo",
        linkedBoardId: null,
        createdAt: 0,
        ...c,
      })),
    });
  }

  it("moves the most recently created, not-done card linked to the board", () => {
    seed([
      { id: "old", linkedBoardId: "b1", createdAt: 1 },
      { id: "new", linkedBoardId: "b1", createdAt: 2 },
      { id: "other-board", linkedBoardId: "b2", createdAt: 3 },
    ]);

    useKanbanStore.getState().moveCardByBoard("b1", "review");

    const cards = useKanbanStore.getState().cards;
    expect(cards.find((c) => c.id === "new")?.column).toBe("review");
    expect(cards.find((c) => c.id === "old")?.column).toBe("todo");
    expect(cards.find((c) => c.id === "other-board")?.column).toBe("todo");
  });

  it("skips a done card for the board in favor of an earlier non-done one", () => {
    seed([
      { id: "in-flight", linkedBoardId: "b1", createdAt: 1, column: "in_progress" },
      { id: "already-done", linkedBoardId: "b1", createdAt: 2, column: "done" },
    ]);

    useKanbanStore.getState().moveCardByBoard("b1", "review");

    const cards = useKanbanStore.getState().cards;
    expect(cards.find((c) => c.id === "in-flight")?.column).toBe("review");
    expect(cards.find((c) => c.id === "already-done")?.column).toBe("done");
  });

  it("falls back to the board's only (done) card when no non-done candidate exists", () => {
    seed([{ id: "done-card", linkedBoardId: "b1", createdAt: 1, column: "done" }]);

    useKanbanStore.getState().moveCardByBoard("b1", "review");

    expect(useKanbanStore.getState().cards[0].column).toBe("review");
  });

  it("is a no-op when no card is linked to the board", () => {
    seed([{ id: "a", linkedBoardId: "b2", createdAt: 1 }]);

    useKanbanStore.getState().moveCardByBoard("b1", "review");

    expect(useKanbanStore.getState().cards[0].column).toBe("todo");
  });
});

describe("kanbanStore — persisted-state migration", () => {
  it("remaps legacy column ids (v1) to the current v2 set", () => {
    const migrate = useKanbanStore.persist.getOptions().migrate!;
    const legacy = {
      cards: [
        { id: "a", column: "backlog" },
        { id: "b", column: "doing" },
        { id: "c", column: "test" },
        { id: "d", column: "review" },
        { id: "e", column: "done" },
        { id: "f", column: "some-unknown-legacy-value" },
      ],
    };

    const migrated = migrate(legacy, 1) as { cards: Array<{ id: string; column: string }> };

    expect(migrated.cards.map((c) => c.column)).toEqual([
      "todo",
      "in_progress",
      "test",
      "review",
      "done",
      "todo",
    ]);
  });

  it("leaves state without cards untouched", () => {
    const migrate = useKanbanStore.persist.getOptions().migrate!;
    expect(migrate(undefined, 1)).toBeUndefined();
  });
});
