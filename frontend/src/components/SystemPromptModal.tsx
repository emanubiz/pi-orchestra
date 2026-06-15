import { useMemo, useState } from "react";
import { RotateCcw, Save, X } from "lucide-react";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { WorkflowNodeData } from "../types";

interface SystemPromptModalProps {
  label: string;
  data: WorkflowNodeData;
  onSave: (promptOverride: string | undefined) => void;
  onClose: () => void;
}

/**
 * View and edit a node's effective system prompt. Saving stores it as a
 * per-node override; "Reset to default" clears the override so the node falls
 * back to its base prompt.
 */
export function SystemPromptModal({ label, data, onSave, onClose }: SystemPromptModalProps) {
  const prompts = useRuntimeStore((s) => s.prompts);
  const base = useMemo(
    () => prompts.find((p) => p.id === data.promptId),
    [prompts, data.promptId],
  );
  const hasOverride = Boolean(data.promptOverride?.trim());
  const [text, setText] = useState(data.promptOverride?.trim() || base?.content || "");

  const save = () => {
    const trimmed = text.trim();
    // Empty, or identical to the base prompt → no override needed.
    onSave(!trimmed || trimmed === base?.content?.trim() ? undefined : trimmed);
    onClose();
  };

  const resetToDefault = () => {
    setText(base?.content || "");
    onSave(undefined);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#09090b] shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-zinc-200 truncate">{label}</span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              system prompt
            </span>
            {hasOverride ? (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30">
                override
              </span>
            ) : (
              base && (
                <span className="text-[10px] text-zinc-500">default: {base.name}</span>
              )
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {hasOverride && (
              <button
                type="button"
                onClick={resetToDefault}
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10"
                title="Clear the override and use the base prompt"
              >
                <RotateCcw size={11} strokeWidth={2} />
                Default
              </button>
            )}
            <button
              type="button"
              onClick={save}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-violet-500/15 text-violet-300 border border-violet-500/30 hover:bg-violet-500/25"
            >
              <Save size={11} strokeWidth={2} />
              Save
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
              title="Close"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 p-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded-lg border border-white/10 bg-zinc-950/80 px-3 py-2 text-[12px] font-mono leading-relaxed text-zinc-200 transition-colors focus:border-violet-500/60 focus:outline-none"
            placeholder="System prompt…"
          />
        </div>
        <div className="px-4 py-1.5 text-[10px] text-zinc-600 border-t border-white/5 shrink-0">
          Changes apply the next time the node's terminal starts (use Restart to reboot it now).
        </div>
      </div>
    </div>
  );
}
