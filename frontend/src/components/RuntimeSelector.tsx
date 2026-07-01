import type { NodeRuntime } from "../types";

interface RuntimeSelectorProps {
  value: NodeRuntime;
  onChange: (runtime: NodeRuntime) => void;
  /** Compact pill for node card header; full row for inspector panels. */
  variant?: "compact" | "full";
  disabled?: boolean;
  /** null = unknown (no warning yet). */
  hermesAvailable?: boolean | null;
  className?: string;
}

const OPTIONS: Array<{ value: NodeRuntime; label: string; short: string }> = [
  { value: "pi", label: "pi", short: "pi" },
  { value: "hermes", label: "hermes", short: "hm" },
];

export function RuntimeSelector({
  value,
  onChange,
  variant = "full",
  disabled,
  hermesAvailable,
  className = "",
}: RuntimeSelectorProps) {
  const hermesWarn = value === "hermes" && hermesAvailable === false;
  const compact = variant === "compact";

  return (
    <div
      className={`flex items-center gap-1 ${className}`}
      title={
        hermesWarn
          ? "Hermes selected but the Hermes CLI was not found on the backend PATH — node will run as pi"
          : "Agent runtime for this node"
      }
    >
      <div
        role="group"
        aria-label="Agent runtime"
        className={`nodrag flex rounded-md border p-0.5 ${
          hermesWarn
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-white/10 bg-zinc-950/60"
        } ${compact ? "shrink-0" : "flex-1"}`}
      >
        {OPTIONS.map((opt) => {
          const active = value === opt.value;
          const isHermesOff = opt.value === "hermes" && hermesAvailable === false;
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
                  ? opt.value === "hermes"
                    ? "bg-purple-500/20 text-purple-300"
                    : "bg-white/10 text-zinc-100"
                  : isHermesOff
                    ? "text-amber-500/70 hover:text-amber-400/90"
                    : "text-zinc-500 hover:text-zinc-300"
              } ${compact ? "min-w-[1.6rem]" : "flex-1"}`}
              title={
                opt.value === "hermes" && hermesAvailable === false
                  ? "Hermes CLI not found on the backend PATH (install Hermes or restart the IDE from a shell that has it)"
                  : `${opt.label} runtime`
              }
            >
              {compact ? opt.short : opt.label}
            </button>
          );
        })}
      </div>
      {!compact && hermesWarn && (
        <span className="text-[9px] text-amber-400/90 shrink-0" title="Backend flag off">
          ⚠
        </span>
      )}
    </div>
  );
}
