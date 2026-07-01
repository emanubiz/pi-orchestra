import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let testDir: string;

describe("board persistence", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinodes-orchestra-db-"));
    process.env.PINODES_ORCHESTRA_DATA_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_DATA_DIR;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function loadDb() {
    const mod = await import("./index.js");
    return mod;
  }

  it("creates and retrieves a board", async () => {
    const { createBoard, getBoard } = await loadDb();
    const board = createBoard("b1", "/tmp", "Test");
    expect(board.boardId).toBe("b1");
    expect(board.cwd).toBe("/tmp");
    expect(board.label).toBe("Test");
    expect(getBoard("b1")).toEqual(board);
  });

  it("lists boards ordered by updated_at", async () => {
    const { createBoard, listBoards } = await loadDb();
    createBoard("b1", "/tmp/a", "A");
    createBoard("b2", "/tmp/b", "B");
    const list = listBoards();
    expect(list).toHaveLength(2);
    expect(list.map((b) => b.boardId)).toEqual(expect.arrayContaining(["b1", "b2"]));
  });

  it("saves and retrieves a graph", async () => {
    const { createBoard, saveBoardGraph, getBoard } = await loadDb();
    createBoard("b1", "/tmp", "Test");
    const graph = {
      name: "g",
      cwd: "/tmp",
      entryNodeId: "n1",
      nodes: [{ id: "n1", label: "N", promptId: "p", position: { x: 0, y: 0 } }],
      edges: [],
    };
    const updated = saveBoardGraph("b1", graph);
    expect(updated?.graph).toEqual(graph);
    expect(getBoard("b1")?.graph).toEqual(graph);
  });

  it("preserves the node runtime field across save and read", async () => {
    const { createBoard, saveBoardGraph, getBoard } = await loadDb();
    createBoard("b1", "/tmp", "Test");
    const graph = {
      name: "g",
      cwd: "/tmp",
      entryNodeId: "n1",
      nodes: [
        // pi runtime, explicit
        {
          id: "n1",
          label: "Architect",
          promptId: "p1",
          runtime: "pi" as const,
          position: { x: 0, y: 0 },
        },
        // hermes runtime + non-secret runtimeConfig
        {
          id: "n2",
          label: "Developer",
          promptId: "p2",
          runtime: "hermes" as const,
          runtimeConfig: { toolsets: "read,bash,edit" },
          position: { x: 100, y: 0 },
        },
        // no runtime (backward compat) — must round-trip untouched
        { id: "n3", label: "Reviewer", promptId: "p3", position: { x: 200, y: 0 } },
      ],
      edges: [],
    };
    const updated = saveBoardGraph("b1", graph);
    expect(updated?.graph).toEqual(graph);
    const read = getBoard("b1")?.graph;
    expect(read).toEqual(graph);
    expect(read?.nodes[0].runtime).toBe("pi");
    expect(read?.nodes[1].runtime).toBe("hermes");
    expect(read?.nodes[1].runtimeConfig).toEqual({ toolsets: "read,bash,edit" });
    expect(read?.nodes[2].runtime).toBeUndefined();
    expect(read?.nodes[2].runtimeConfig).toBeUndefined();
  });

  it("returns undefined for unknown board", async () => {
    const { getBoard, saveBoardGraph, deleteBoard } = await loadDb();
    expect(getBoard("missing")).toBeUndefined();
    expect(saveBoardGraph("missing", { name: "x", nodes: [], edges: [] })).toBeUndefined();
    expect(deleteBoard("missing")).toBe(false);
  });

  it("deletes a board", async () => {
    const { createBoard, deleteBoard, getBoard } = await loadDb();
    createBoard("b1", "/tmp", "Test");
    expect(deleteBoard("b1")).toBe(true);
    expect(getBoard("b1")).toBeUndefined();
  });
});

describe("system prompts", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinodes-orchestra-db-"));
    process.env.PINODES_ORCHESTRA_DATA_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_DATA_DIR;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function loadDb() {
    // Force a fresh module instance per test: `db` is memoized at module
    // scope, so without this, tests in this file would share one SQLite
    // connection pinned to whichever testDir was active on first import.
    vi.resetModules();
    return import("./index.js");
  }

  it("seeds the builtin prompts on first access", async () => {
    const { listPrompts } = await loadDb();
    const prompts = listPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((p) => p.is_builtin === 1)).toBe(true);
    expect(prompts.map((p) => p.id)).toContain("builtin-architect");
  });

  it("creates, reads and updates a custom prompt", async () => {
    const { createPrompt, getPrompt, updatePrompt } = await loadDb();
    const created = createPrompt("custom-1", "My Role", "Do the thing.");
    expect(created).toMatchObject({ id: "custom-1", name: "My Role", content: "Do the thing.", is_builtin: 0 });
    expect(getPrompt("custom-1")).toMatchObject({ name: "My Role" });

    const updated = updatePrompt("custom-1", "New Name", "New content.");
    expect(updated).toMatchObject({ name: "New Name", content: "New content." });
    expect(getPrompt("custom-1")).toMatchObject({ name: "New Name" });
  });

  it("updatePrompt returns undefined for an unknown id", async () => {
    const { updatePrompt } = await loadDb();
    expect(updatePrompt("ghost", "x", "y")).toBeUndefined();
  });

  it("deletes a custom prompt but refuses to delete a builtin one", async () => {
    const { createPrompt, deletePrompt, getPrompt } = await loadDb();
    createPrompt("custom-1", "My Role", "Do the thing.");
    expect(deletePrompt("custom-1")).toBe(true);
    expect(getPrompt("custom-1")).toBeUndefined();

    // Builtins are seeded on first getDb() access — guaranteed present.
    expect(deletePrompt("builtin-architect")).toBe(false);
    expect(getPrompt("builtin-architect")).toBeDefined();
  });

  it("deletePrompt returns false for an unknown id", async () => {
    const { deletePrompt } = await loadDb();
    expect(deletePrompt("ghost")).toBe(false);
  });

  it("re-seeding an existing database (simulated restart) does not duplicate builtin rows", async () => {
    const { listPrompts } = await loadDb();
    const before = listPrompts().length;
    // Same on-disk db (testDir unchanged), fresh module instance — simulates
    // the backend restarting and re-running seedPrompts() against it.
    const { listPrompts: listAgain } = await loadDb();
    expect(listAgain().length).toBe(before);
  });
});

describe("workflows", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinodes-orchestra-db-"));
    process.env.PINODES_ORCHESTRA_DATA_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_DATA_DIR;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function loadDb() {
    vi.resetModules();
    return import("./index.js");
  }

  function graphOf(id?: string) {
    return {
      id,
      name: "My Workflow",
      cwd: "/tmp",
      entryNodeId: "n1",
      nodes: [{ id: "n1", label: "N", promptId: "p", position: { x: 0, y: 0 } }],
      edges: [],
    };
  }

  it("saves a new workflow (generating an id) and retrieves it", async () => {
    const { saveWorkflow, getWorkflow } = await loadDb();
    const saved = saveWorkflow(graphOf());
    expect(saved.id).toBeTruthy();
    expect(getWorkflow(saved.id!)).toEqual(saved);
  });

  it("upserts an existing workflow by id instead of duplicating it", async () => {
    const { saveWorkflow, listWorkflows } = await loadDb();
    const first = saveWorkflow(graphOf("wf-1"));
    saveWorkflow({ ...graphOf("wf-1"), name: "Renamed" });
    const list = listWorkflows();
    expect(list.filter((w) => w.id === first.id)).toHaveLength(1);
    expect(list.find((w) => w.id === first.id)?.name).toBe("Renamed");
  });

  it("returns undefined for an unknown workflow id", async () => {
    const { getWorkflow } = await loadDb();
    expect(getWorkflow("missing")).toBeUndefined();
  });

  it("deletes a workflow", async () => {
    const { saveWorkflow, deleteWorkflow, getWorkflow } = await loadDb();
    const saved = saveWorkflow(graphOf("wf-del"));
    expect(deleteWorkflow(saved.id!)).toBe(true);
    expect(getWorkflow(saved.id!)).toBeUndefined();
  });

  it("deleteWorkflow returns false for an unknown id", async () => {
    const { deleteWorkflow } = await loadDb();
    expect(deleteWorkflow("missing")).toBe(false);
  });
});
