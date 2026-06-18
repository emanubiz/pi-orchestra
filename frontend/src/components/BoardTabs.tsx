import { Plus, X } from "lucide-react";
import { useBoardStore } from "../stores/boardStore";
import { apiFetch } from "../lib/api";

interface BoardTabsProps {
  onBoardSwitch: (boardId: string) => void;
}

export function BoardTabs({ onBoardSwitch }: BoardTabsProps) {
  const boards = useBoardStore((s) => s.boards);
  const activeBoardId = useBoardStore((s) => s.activeBoardId);
  const setActiveBoard = useBoardStore((s) => s.setActiveBoard);
  const addBoard = useBoardStore((s) => s.addBoard);
  const removeBoard = useBoardStore((s) => s.removeBoard);

  const handleAdd = async () => {
    const fallback = useBoardStore.getState().defaultCwd ?? ".";
    const path = window.prompt("Folder / repo path:", fallback);
    if (!path?.trim()) return;
    const res = await apiFetch("/api/validate-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.trim() }),
    });
    const data = (await res.json()) as { ok: boolean; path?: string; error?: string };
    if (!data.ok) {
      window.alert(data.error ?? "Invalid path");
      return;
    }
    const board = addBoard(data.path!);
    onBoardSwitch(board.id);
  };

  const selectBoard = (id: string) => {
    setActiveBoard(id);
    onBoardSwitch(id);
  };

  return (
    <div className="flex h-full w-[200px] shrink-0 flex-col border-r border-white/5 bg-zinc-950/40">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Repo</span>
        <button
          type="button"
          onClick={() => void handleAdd()}
          className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06] border border-white/10 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 active:scale-90"
          title="New board"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {boards.map((b) => {
          const active = b.id === activeBoardId;
          return (
            <div
              key={b.id}
              className={`group relative flex items-start gap-1 rounded-md px-2.5 py-2 cursor-pointer border transition-all duration-150 ${
                active
                  ? "bg-white/[0.06] border-white/10"
                  : "border-transparent hover:bg-white/[0.03]"
              }`}
              onClick={() => selectBoard(b.id)}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-full bg-zinc-400/80" />
              )}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium truncate ${active ? "text-white" : "text-zinc-200"}`}>{b.label}</div>
                <div className="text-[10px] text-zinc-500 truncate" title={b.cwd}>
                  {b.cwd}
                </div>
              </div>
              {boards.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Close board "${b.label}"?`)) removeBoard(b.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 rounded p-0.5 transition-colors"
                  title="Close board"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
