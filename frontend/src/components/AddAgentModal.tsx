import { useMemo, useState } from "react";
import { Eye, Plus, X } from "lucide-react";
import { apiFetch } from "../lib/api";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { NodeRuntime, SystemPrompt } from "../types";
import { RuntimeSelector } from "./RuntimeSelector";

export interface AddAgentChoice {
  prompt: SystemPrompt;
  runtime: NodeRuntime;
}

interface AddAgentModalProps {
  prompts: SystemPrompt[];
  onClose: () => void;
  onConfirm: (choice: AddAgentChoice) => void;
  onRefreshPrompts: () => void;
}

type Step = "pick" | "runtime";

export function AddAgentModal({
  prompts,
  onClose,
  onConfirm,
  onRefreshPrompts,
}: AddAgentModalProps) {
  const hermesAvailable = useRuntimeStore((s) => s.hermesAvailable);
  const claudeAvailable = useRuntimeStore((s) => s.claudeAvailable);
  const codexAvailable = useRuntimeStore((s) => s.codexAvailable);
  const [step, setStep] = useState<Step>("pick");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SystemPrompt | null>(null);
  const [preview, setPreview] = useState<SystemPrompt | null>(null);
  const [runtime, setRuntime] = useState<NodeRuntime>("pi");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prompts;
    return prompts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q),
    );
  }, [prompts, query]);

  const saveCustomPrompt = async () => {
    const name = newName.trim();
    const content = newContent.trim();
    if (!name || !content) return;
    const res = await apiFetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    const created = (await res.json()) as SystemPrompt;
    onRefreshPrompts();
    setCreating(false);
    setNewName("");
    setNewContent("");
    setSelected(created);
    setStep("runtime");
  };

  const goRuntime = () => {
    if (!selected) return;
    setStep("runtime");
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#09090b] shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-3 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              {step === "pick" ? "Add agent" : "Choose runtime"}
            </h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {step === "pick"
                ? "Pick a system prompt — view only reads it; Add continues to runtime."
                : "Runtime is fixed when the node is created and cannot be changed later."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
            title="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {step === "pick" && (
          <>
            <div className="px-4 pt-3 pb-2 shrink-0 space-y-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts…"
                autoFocus
                className="w-full rounded-lg border border-white/10 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-violet-500/50 focus:outline-none"
              />
              {!creating ? (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex items-center gap-1.5 text-xs font-medium text-violet-300 hover:text-violet-200 transition-colors"
                >
                  <Plus size={12} strokeWidth={2} />
                  Create custom prompt
                </button>
              ) : (
                <div className="rounded-lg border border-white/10 bg-zinc-900/50 p-3 space-y-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Prompt name"
                    className="w-full rounded-md border border-white/10 bg-zinc-950/80 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-violet-500/50 focus:outline-none"
                  />
                  <textarea
                    value={newContent}
                    onChange={(e) => setNewContent(e.target.value)}
                    placeholder="System prompt…"
                    rows={4}
                    className="w-full rounded-md border border-white/10 bg-zinc-950/80 px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:border-violet-500/50 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void saveCustomPrompt()}
                      disabled={!newName.trim() || !newContent.trim()}
                      className="text-xs font-medium px-3 py-1.5 rounded-md bg-violet-500/20 text-violet-200 border border-violet-500/30 hover:bg-violet-500/30 disabled:opacity-40"
                    >
                      Save & continue
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreating(false)}
                      className="text-xs px-3 py-1.5 rounded-md text-zinc-500 hover:text-zinc-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
              {filtered.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg px-2 py-2 mb-0.5 transition-colors ${
                    selected?.id === p.id
                      ? "bg-violet-500/10 border border-violet-500/25"
                      : "border border-transparent hover:bg-white/[0.03]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(p)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="block text-sm font-medium text-zinc-200 truncate">
                      {p.name}
                    </span>
                    <span className="block text-[10px] text-zinc-500 truncate mt-0.5">
                      {p.is_builtin ? "Built-in" : "Custom"} · {p.content.slice(0, 72)}
                      {p.content.length > 72 ? "…" : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="View prompt"
                    onClick={() => setPreview(p)}
                    className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                  >
                    <Eye size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-zinc-600">No prompts match</p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-white/5 px-4 py-3 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selected}
                onClick={goRuntime}
                className="text-xs font-medium px-4 py-1.5 rounded-md bg-violet-500/20 text-violet-200 border border-violet-500/30 hover:bg-violet-500/30 disabled:opacity-40"
              >
                Next — choose runtime
              </button>
            </div>
          </>
        )}

        {step === "runtime" && selected && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
              <div className="rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-2.5">
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">Prompt</span>
                <p className="text-sm font-medium text-zinc-200 mt-0.5">{selected.name}</p>
              </div>
              <div className="space-y-2">
                <span className="text-xs font-medium text-zinc-300">Agent runtime</span>
                <RuntimeSelector
                  value={runtime}
                  hermesAvailable={hermesAvailable}
                  claudeAvailable={claudeAvailable}
                  codexAvailable={codexAvailable}
                  onChange={setRuntime}
                />
                {runtime === "hermes" && hermesAvailable === false && (
                  <p className="text-[11px] leading-snug text-amber-400/90">
                    The backend did not find <code className="font-mono">hermes</code> on its PATH.
                    Install Hermes, or restart Cursor from a terminal where{" "}
                    <code className="font-mono">hermes --version</code> works. Until then this node
                    runs as pi.
                  </p>
                )}
                {runtime === "claude" && claudeAvailable === false && (
                  <p className="text-[11px] leading-snug text-amber-400/90">
                    The backend did not find <code className="font-mono">claude</code> on its PATH.
                    Install Claude Code, or restart Cursor from a terminal where{" "}
                    <code className="font-mono">claude --version</code> works. Until then this node
                    runs as pi.
                  </p>
                )}
                {runtime === "codex" && codexAvailable === false && (
                  <p className="text-[11px] leading-snug text-amber-400/90">
                    The backend did not find <code className="font-mono">codex</code> on its PATH.
                    Install Codex, or restart Cursor from a terminal where{" "}
                    <code className="font-mono">codex --version</code> works. Unlike pi/hermes/claude,
                    this node will not fall back — it will fail to start until Codex is available.
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-between gap-2 border-t border-white/5 px-4 py-3 shrink-0">
              <button
                type="button"
                onClick={() => setStep("pick")}
                className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => onConfirm({ prompt: selected, runtime })}
                className="text-xs font-medium px-4 py-1.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/25"
              >
                Create agent node
              </button>
            </div>
          </>
        )}

        {preview && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setPreview(null)}
          >
            <div
              className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-950 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-white/5 px-3 py-2 shrink-0">
                <span className="text-sm font-medium text-zinc-200">{preview.name}</span>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="rounded p-1 text-zinc-500 hover:text-zinc-200"
                >
                  <X size={14} />
                </button>
              </div>
              <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono leading-relaxed text-zinc-300 whitespace-pre-wrap">
                {preview.content}
              </pre>
              <div className="flex justify-end gap-2 border-t border-white/5 px-3 py-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="text-xs px-3 py-1 rounded-md text-zinc-400 hover:text-zinc-200"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(preview);
                    setPreview(null);
                    setStep("runtime");
                  }}
                  className="text-xs font-medium px-3 py-1 rounded-md bg-violet-500/20 text-violet-200 border border-violet-500/30"
                >
                  Use this prompt
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
