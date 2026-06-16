import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { Node } from "@xyflow/react";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { SystemPrompt, WorkflowNodeData } from "../types";

interface NodeInspectorProps {
  boardId: string;
  entryNodeId: string | null;
  onSetEntry: (nodeId: string | null) => void;
  onUpdateNode: (nodeId: string, patch: Partial<WorkflowNodeData>) => void;
  onRunFromHere: (nodeId: string, message: string) => void;
  getSelectedNode: () => Node<WorkflowNodeData> | undefined;
}

export function NodeInspector({
  boardId,
  entryNodeId,
  onSetEntry,
  onUpdateNode,
  onRunFromHere,
  getSelectedNode,
}: NodeInspectorProps) {
  const selectedNodeId = useRuntimeStore((s) => s.selectedNodeId);
  const nodeStatus = useRuntimeStore((s) =>
    selectedNodeId ? s.nodeStatus[`${boardId}:${selectedNodeId}`] : undefined,
  );
  const prompts = useRuntimeStore((s) => s.prompts);
  const runPromptDraft = useRuntimeStore((s) => s.runPromptDraft);
  const setRunPromptDraft = useRuntimeStore((s) => s.setRunPromptDraft);

  const node = selectedNodeId ? getSelectedNode() : undefined;
  const [override, setOverride] = useState("");

  useEffect(() => {
    setOverride(node?.data.promptOverride ?? "");
  }, [node?.id, node?.data.promptOverride]);

  if (!selectedNodeId || !node) {
    return (
      <div className="border-t border-white/5 px-3.5 py-2.5 text-xs text-zinc-500">
        Select a node for prompt override and entry point
      </div>
    );
  }

  const basePrompt = prompts.find((p) => p.id === node.data.promptId);

  const applyPromptId = (prompt: SystemPrompt) => {
    onUpdateNode(selectedNodeId, {
      promptId: prompt.id,
      label: prompt.name,
      promptOverride: undefined,
    });
    setOverride("");
  };

  return (
    <div className="border-t border-white/5 px-3.5 py-2.5 space-y-2.5 shrink-0 max-h-[220px] overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-300 truncate">
          <span className="text-zinc-500 font-normal">Node:</span> {node.data.label}
        </span>
        <button
          type="button"
          onClick={() =>
            onSetEntry(entryNodeId === selectedNodeId ? null : selectedNodeId)
          }
          className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
            entryNodeId === selectedNodeId
              ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
              : "bg-white/5 text-zinc-400 border-white/10 hover:text-zinc-200 hover:border-white/20"
          }`}
        >
          {entryNodeId === selectedNodeId ? "Entry" : "Set entry"}
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {prompts.slice(0, 6).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPromptId(p)}
            className={`text-[10px] px-1.5 py-0.5 rounded-md border transition-colors ${
              p.id === node.data.promptId
                ? "border-white/25 bg-white/10 text-zinc-100"
                : "border-white/10 text-zinc-500 hover:border-white/25 hover:text-zinc-300"
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      <textarea
        value={override}
        onChange={(e) => setOverride(e.target.value)}
        onBlur={() => {
          onUpdateNode(selectedNodeId, {
            promptOverride: override.trim() || undefined,
          });
        }}
        rows={3}
        placeholder={
          basePrompt
    ? `Override (default: ${basePrompt.name})...`
    : "Override system prompt..."
        }
        className="w-full rounded-lg border border-white/10 bg-zinc-950/80 px-2.5 py-1.5 text-[11px] font-mono text-zinc-300 transition-colors focus:border-zinc-500/70 focus:outline-none"
      />

      <div className="flex gap-2">
        <input
          value={runPromptDraft}
          onChange={(e) => setRunPromptDraft(e.target.value)}
          placeholder="Flow start message…"
          className="flex-1 rounded-lg border border-white/10 bg-zinc-950/80 px-2.5 py-1.5 text-xs transition-colors focus:border-violet-500/60 focus:outline-none"
        />
        <button
          type="button"
          disabled={nodeStatus === "running"}
          onClick={() => {
            if (!runPromptDraft.trim()) return;
            onRunFromHere(selectedNodeId, runPromptDraft.trim());
          }}
          className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-200 transition-colors hover:bg-white/10 hover:border-white/20 active:scale-95 disabled:opacity-40 disabled:active:scale-100"
        >
          <Play size={11} strokeWidth={2} fill="currentColor" />
          Run
        </button>
      </div>
    </div>
  );
}
