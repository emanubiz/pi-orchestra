import { useEffect, useRef, useState } from "react";
import { FolderOpen, Workflow } from "lucide-react";
import { apiFetch } from "../lib/api";
import { WORKFLOW_TEMPLATES } from "../lib/workflowTemplates";
import type { SavedWorkflowListItem, WorkflowGraph } from "../types";

interface WorkflowPickerProps {
  cwd: string;
  currentId: string | null;
  onLoad: (graph: WorkflowGraph) => void;
  compact?: boolean;
}

export function WorkflowPicker({ cwd, currentId, onLoad, compact }: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<SavedWorkflowListItem[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const res = await apiFetch("/api/workflows");
    setWorkflows((await res.json()) as SavedWorkflowListItem[]);
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const load = async (id: string) => {
    const res = await apiFetch(`/api/workflows/${id}`);
    if (!res.ok) return;
    const graph = (await res.json()) as WorkflowGraph;
    onLoad({ ...graph, cwd: graph.cwd ?? cwd });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={compact ? "toolbar-btn" : "flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.97]"}
        title="Load saved workflow"
      >
        <FolderOpen size={14} strokeWidth={1.75} />
        {!compact && <span>Load…</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-64 max-h-80 overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-900 shadow-xl shadow-black/40 p-1 fade-rise">
          {/* Built-in templates */}
          <div className="px-2.5 py-1">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              <Workflow size={10} strokeWidth={2} />
              Templates
            </span>
          </div>
          {WORKFLOW_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => {
                onLoad({ ...tpl.graph, cwd });
                setOpen(false);
              }}
              className="w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-violet-500/10 text-zinc-300"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm leading-none">{tpl.icon}</span>
                <span className="font-medium truncate">{tpl.name}</span>
              </div>
              <div className="text-zinc-500 truncate mt-0.5">{tpl.graph.nodes.length} nodes · {tpl.category}</div>
            </button>
          ))}

          {/* Saved workflows — only shown when there are some */}
          {workflows.length > 0 && (
            <>
              <div className="mx-2 my-1 border-t border-white/5" />
              <div className="px-2.5 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Saved</span>
              </div>
              {workflows.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => void load(w.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-white/5 ${
                    w.id === currentId ? "text-zinc-100 bg-white/[0.06]" : "text-zinc-300"
                  }`}
                >
                  <div className="font-medium truncate">{w.name}</div>
                  <div className="text-zinc-500">{new Date(w.updated_at).toLocaleString()}</div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
