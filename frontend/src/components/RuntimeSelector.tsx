import type { NodeRuntime } from "../types";

interface RuntimeSelectorProps {
  value: NodeRuntime;
  onChange: (runtime: NodeRuntime) => void;
  /** Compact pill for node card header; full row for inspector panels. */
  variant?: "compact" | "full";
  disabled?: boolean;
  /** null = unknown (no warning yet). */
  hermesAvailable?: boolean | null;
  /** null = unknown (no warning yet). */
  claudeAvailable?: boolean | null;
  className?: string;
}

const OPTIONS: Array<{ value: NodeRuntime; label: string; short: string }> = [
  { value: "pi", label: "pi", short: "pi" },
  { value: "hermes", label: "hermes", short: "hm" },
  { value: "claude", label: "claude", short: "cc" },
];

/** Active-state accent per runtime (pi stays neutral). */
const ACTIVE_CLASS: Record<NodeRuntime, string> = {
  pi: "bg-white/10 text-zinc-100",
  hermes: "bg-purple-500/20 text-purple-300",
  claude: "bg-orange-500/20 text-orange-300",
};

const UNAVAILABLE_HINT: Record<string, string> = {
  hermes:
    "Hermes CLI not found on the backend PATH (install Hermes or restart the IDE from a shell that has it)",
  claude:
    "Claude Code CLI not found on the backend PATH (install Claude Code or restart the IDE from a shell that has it)",
};

export function RuntimeSelector({
  value,
  onChange,
  variant = "full",
  disabled,
  hermesAvailable,
  claudeAvailable,
  className = "",
}: RuntimeSelectorProps) {
  const availability: Partial<Record<NodeRuntime, boolean | null | undefined>> = {
    hermes: hermesAvailable,
    claude: claudeAvailable,
  };
  const selectedUnavailable = availability[value] === false;
  const compact = variant === "compact";

  return (
    <div
      className={`flex items-center gap-1 ${className}`}
      title={
        selectedUnavailable
          ? `${value} selected but its CLI was not found on the backend PATH — node will run as pi`
          : "Agent runtime for this node"
      }
    >
      <div
        role="group"
        aria-label="Agent runtime"
        className={`nodrag flex rounded-md border p-0.5 ${
          selectedUnavailable
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-white/10 bg-zinc-950/60"
        } ${compact ? "shrink-0" : "flex-1"}`}
      >
        {OPTIONS.map((opt) => {
          const active = value === opt.value;
          const unavailable = availability[opt.value] === false;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                if (opt.value !== value) onChange(opt.value);
              }}
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
                active
                  ? ACTIVE_CLASS[opt.value]
                  : unavailable
                    ? "text-amber-500/70 hover:text-amber-400/90"
                    : "text-zinc-500 hover:text-zinc-300"
              } ${compact ? "min-w-[1.6rem]" : "flex-1"}`}
              title={unavailable ? UNAVAILABLE_HINT[opt.value] : `${opt.label} runtime`}
            >
              {compact ? opt.short : opt.label}
            </button>
          );
        })}
      </div>
      {!compact && selectedUnavailable && (
        <span className="text-[9px] text-amber-400/90 shrink-0" title="Runtime unavailable on the backend">
          ⚠
        </span>
      )}
    </div>
  );
}
