import { Plus } from "lucide-react";

interface PromptLibraryProps {
  onAddAgent: () => void;
}

export function PromptLibrary({ onAddAgent }: PromptLibraryProps) {
  return (
    <div className="border-b border-white/5 bg-zinc-950/50 backdrop-blur-sm px-3.5 py-2 flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-zinc-400">Agents</span>
      <button
        type="button"
        onClick={onAddAgent}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10 hover:border-white/20 active:scale-[0.98]"
      >
        <Plus size={14} strokeWidth={2} />
        Add agent
      </button>
    </div>
  );
}
