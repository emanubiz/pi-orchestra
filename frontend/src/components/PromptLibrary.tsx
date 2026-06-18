import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { apiFetch } from "../lib/api";
import type { SystemPrompt } from "../types";

interface PromptLibraryProps {
  prompts: SystemPrompt[];
  onRefresh: () => void;
  onAddNode: (prompt: SystemPrompt) => void;
}

export function PromptLibrary({ prompts, onRefresh, onAddNode }: PromptLibraryProps) {
  const [expanded, setExpanded] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? prompts.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
    : prompts;

  const createPrompt = async () => {
    await apiFetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    setShowNew(false);
    setName("");
    setContent("");
    onRefresh();
  };

  return (
    <div className="border-b border-white/5 bg-zinc-950/50 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
      >
        Prompts
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={`text-zinc-500 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-0.5 max-h-56 overflow-y-auto">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-md bg-zinc-950/80 border border-white/10 px-2 py-1 text-xs text-zinc-300 transition-colors focus:border-zinc-500/70 focus:outline-none mb-1"
          />
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onAddNode(p)}
              className="w-full flex items-center rounded-md px-2 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/[0.03] hover:text-white group"
            >
              <span className="flex-1 truncate">{p.name}</span>
              <span className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0 ml-2">
                <Plus size={10} strokeWidth={2} />
                node
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-2 py-2 text-xs text-zinc-600">No results</div>
          )}

          {!showNew ? (
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="mt-1 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/10 py-2 text-xs text-zinc-500 transition-colors hover:border-white/20 hover:text-zinc-300"
            >
              <Plus size={13} strokeWidth={2} />
              New prompt
            </button>
          ) : (
            <div className="rounded-lg border border-white/10 bg-zinc-900/50 p-2.5 space-y-2 fade-rise mt-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                className="w-full rounded-md bg-zinc-950/80 border border-white/10 px-2.5 py-1.5 text-xs transition-colors focus:border-zinc-500/70 focus:outline-none"
              />
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="System prompt…"
                rows={3}
                className="w-full rounded-md bg-zinc-950/80 border border-white/10 px-2.5 py-1.5 text-xs transition-colors focus:border-zinc-500/70 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={createPrompt}
                  className="text-xs font-medium px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 hover:text-white transition-colors"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowNew(false)}
                  className="text-xs px-2.5 py-1 rounded-md text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
