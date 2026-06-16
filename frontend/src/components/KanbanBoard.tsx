import { useState } from "react";
import { ExternalLink, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
  KANBAN_COLUMNS,
  useKanbanStore,
  type KanbanCard,
  type KanbanColumnId,
} from "../stores/kanbanStore";
import { useBoardStore } from "../stores/boardStore";
import { useRuntimeStore } from "../stores/runtimeStore";

const COLUMN_ACCENTS: Record<KanbanColumnId, { dot: string; header: string }> = {
  todo: { dot: "bg-zinc-500", header: "text-zinc-400" },
  in_progress: { dot: "bg-amber-400", header: "text-amber-400/90" },
  test: { dot: "bg-violet-400", header: "text-violet-400/90" },
  review: { dot: "bg-sky-400", header: "text-sky-400/90" },
  done: { dot: "bg-emerald-400", header: "text-emerald-400/90" },
};

const COLUMN_EMPTY: Record<KanbanColumnId, string> = {
  todo: "Add a card or drag here",
  in_progress: "Pipeline running",
  test: "Waiting for verification",
  review: "Ready for review",
  done: "Completed",
};

interface KanbanBoardProps {
  onOpenBoard: (boardId: string) => void;
  onLaunch: (boardId: string, task: string) => void;
}

export function KanbanBoard({ onOpenBoard, onLaunch }: KanbanBoardProps) {
  const cards = useKanbanStore((s) => s.cards);
  const addCard = useKanbanStore((s) => s.addCard);
  const moveCard = useKanbanStore((s) => s.moveCard);
  const nodeStatus = useRuntimeStore((s) => s.nodeStatus);
  const [dragOver, setDragOver] = useState<KanbanColumnId | null>(null);

  const boardIsLive = (boardId: string) =>
    Object.entries(nodeStatus).some(
      ([key, status]) => key.startsWith(`${boardId}:`) && status === "running",
    );

  return (
    <div className="flex h-full gap-3 overflow-x-auto bg-zinc-950/30 p-4">
      {KANBAN_COLUMNS.map((col) => {
        const colCards = cards.filter((c) => c.column === col.id);
        const accent = COLUMN_ACCENTS[col.id];
        return (
          <div
            key={col.id}
            className={`flex w-[280px] shrink-0 flex-col rounded-xl border bg-white/[0.015] transition-colors ${
              dragOver === col.id ? "border-zinc-500/60 bg-white/[0.04]" : "border-white/5"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col.id);
            }}
            onDragLeave={() => setDragOver((d) => (d === col.id ? null : d))}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("text/card");
              if (id) moveCard(id, col.id);
              setDragOver(null);
            }}
          >
            <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
              <span className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${accent.header}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />
                {col.label}
              </span>
              <span className="text-[10px] text-zinc-600 tabular-nums">{colCards.length}</span>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
              {colCards.length === 0 && (
                <div className="rounded-md border border-dashed border-white/[0.06] px-2.5 py-3 text-center text-[11px] text-zinc-600">
                  {COLUMN_EMPTY[col.id]}
                </div>
              )}
              {colCards.map((card) => (
                <CardItem
                  key={card.id}
                  card={card}
                  isLive={card.linkedBoardId ? boardIsLive(card.linkedBoardId) : false}
                  onOpenBoard={onOpenBoard}
                  onLaunch={onLaunch}
                />
              ))}
            </div>

            <AddCard columnId={col.id} onAdd={(title) => addCard(col.id, title)} />
          </div>
        );
      })}
    </div>
  );
}

function CardItem({
  card,
  isLive,
  onOpenBoard,
  onLaunch,
}: {
  card: KanbanCard;
  isLive: boolean;
  onOpenBoard: (boardId: string) => void;
  onLaunch: (boardId: string, task: string) => void;
}) {
  const updateCard = useKanbanStore((s) => s.updateCard);
  const removeCard = useKanbanStore((s) => s.removeCard);
  const moveCard = useKanbanStore((s) => s.moveCard);
  const boards = useBoardStore((s) => s.boards);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [desc, setDesc] = useState(card.description);

  const linkedBoard = card.linkedBoardId
    ? boards.find((b) => b.id === card.linkedBoardId)
    : undefined;

  if (editing) {
    return (
      <div className="rounded-lg border border-white/15 bg-zinc-900/70 p-2 space-y-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full rounded-md bg-zinc-950/80 border border-white/10 px-2 py-1 text-sm text-zinc-100 focus:border-zinc-500/70 focus:outline-none"
        />
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description…"
          rows={2}
          className="w-full resize-none rounded-md bg-zinc-950/80 border border-white/10 px-2 py-1 text-xs text-zinc-300 focus:border-zinc-500/70 focus:outline-none"
        />
        <select
          value={card.linkedBoardId ?? ""}
          onChange={(e) => updateCard(card.id, { linkedBoardId: e.target.value || null })}
          className="w-full rounded-md bg-zinc-950/80 border border-white/10 px-2 py-1 text-xs text-zinc-300 focus:border-zinc-500/70 focus:outline-none"
        >
          <option value="">- no agents board -</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              updateCard(card.id, { title: title.trim() || "Untitled", description: desc });
              setEditing(false);
            }}
            className="text-xs font-medium text-zinc-200 hover:text-white"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setTitle(card.title);
              setDesc(card.description);
              setEditing(false);
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/card", card.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="group rounded-lg border border-white/10 bg-zinc-900/60 p-2.5 cursor-grab active:cursor-grabbing transition-colors hover:border-white/20 hover:bg-zinc-900/90"
    >
      <div className="flex items-start gap-1.5">
        <span className="flex-1 text-sm text-zinc-100 leading-snug break-words">{card.title}</span>
        {isLive && (
          <span
            className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 live-dot"
            title="Pipeline running"
          />
        )}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded p-0.5 text-zinc-500 hover:text-zinc-200 transition-colors"
            title="Edit"
          >
            <Pencil size={12} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => removeCard(card.id)}
            className="rounded p-0.5 text-zinc-500 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      {card.description && (
        <p className="mt-1 text-xs text-zinc-500 leading-snug break-words whitespace-pre-wrap">
          {card.description}
        </p>
      )}

      {linkedBoard && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => onOpenBoard(linkedBoard.id)}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
            title="Open the linked agents board"
          >
            <ExternalLink size={10} strokeWidth={2} />
            {linkedBoard.label}
          </button>
          <button
            type="button"
            onClick={() => {
              const task = card.description
                ? `${card.title}\n\n${card.description}`
                : card.title;
              onLaunch(linkedBoard.id, task);
              moveCard(card.id, "in_progress");
            }}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/[0.08] px-1.5 py-0.5 text-[10px] text-emerald-400/90 hover:bg-emerald-500/15 transition-colors"
            title="Open the board and start the pipeline with this card as the task"
          >
            <Play size={10} strokeWidth={2} fill="currentColor" />
            Start
          </button>
        </div>
      )}
    </div>
  );
}

function AddCard({
  columnId,
  onAdd,
}: {
  columnId: KanbanColumnId;
  onAdd: (title: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");

  const commit = () => {
    if (value.trim()) onAdd(value);
    setValue("");
    setAdding(false);
  };

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="m-2 flex items-center justify-center gap-1 rounded-md border border-dashed border-white/10 py-1.5 text-xs text-zinc-500 transition-colors hover:border-white/25 hover:text-zinc-300"
      >
        <Plus size={13} strokeWidth={2} />
        Add card
      </button>
    );
  }

  return (
    <div className="m-2">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setValue("");
            setAdding(false);
          }
        }}
        onBlur={commit}
        rows={2}
        placeholder="Card title… (Enter to add)"
        className="w-full resize-none rounded-md bg-zinc-950/80 border border-white/10 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500/70 focus:outline-none"
        data-column={columnId}
      />
    </div>
  );
}
