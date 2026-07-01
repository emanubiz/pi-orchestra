import type { NodeRuntime } from "../types";

const SHORT: Record<NodeRuntime, string> = { pi: "pi", hermes: "hm" };

export function RuntimeBadge({
  runtime,
  compact = false,
}: {
  runtime: NodeRuntime;
  compact?: boolean;
}) {
  const isHermes = runtime === "hermes";
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
        isHermes
          ? "text-purple-300/90 bg-purple-500/15 border border-purple-500/20"
          : "text-zinc-500 bg-white/5 border border-white/10"
      }`}
      title={`Runtime: ${runtime} (fixed at creation)`}
    >
      {compact ? SHORT[runtime] : runtime}
    </span>
  );
}
