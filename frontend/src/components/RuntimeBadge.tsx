import type { NodeRuntime } from "../types";

const SHORT: Record<NodeRuntime, string> = { pi: "pi", hermes: "hm", claude: "cc", codex: "cx" };

const STYLE: Record<NodeRuntime, string> = {
  pi: "text-zinc-500 bg-white/5 border border-white/10",
  hermes: "text-purple-300/90 bg-purple-500/15 border border-purple-500/20",
  claude: "text-orange-300/90 bg-orange-500/15 border border-orange-500/20",
  codex: "text-sky-300/90 bg-sky-500/15 border border-sky-500/20",
};

export function RuntimeBadge({
  runtime,
  compact = false,
}: {
  runtime: NodeRuntime;
  compact?: boolean;
}) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${STYLE[runtime]}`}
      title={`Runtime: ${runtime} (fixed at creation)`}
    >
      {compact ? SHORT[runtime] : runtime}
    </span>
  );
}
