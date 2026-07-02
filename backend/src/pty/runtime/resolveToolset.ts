/** pi tool names (read/bash/edit/write/grep). Not valid Hermes toolset names. */
export const PI_DEFAULT_TOOLSET = "read,bash,edit,write,grep";
/** Hermes built-in toolset names covering file ops + shell (see `hermes tools list`). */
export const HERMES_DEFAULT_TOOLSET = "file,terminal";
/** Claude Code tool names for `--allowedTools` (capitalized, Claude's own vocabulary). */
export const CLAUDE_DEFAULT_TOOLSET = "Read,Edit,Write,Bash,Grep,Glob";

/**
 * Resolve the tool list a runtime passes on its command line: the `toolset`
 * field of the node's `runtimeConfig` when set to a non-empty string,
 * otherwise the runtime's default. Any other type (or an absent/blank value)
 * is ignored rather than passed through — runtimeConfig is untyped, user-edited
 * JSON reaching a spawned CLI's argv.
 *
 * `defaultToolset` is runtime-specific: pi and Hermes use different toolset
 * vocabularies, so the caller supplies the right default.
 */
export function resolveToolset(
  runtimeConfig: Record<string, unknown> | undefined,
  defaultToolset: string = PI_DEFAULT_TOOLSET,
): string {
  const configured = runtimeConfig?.toolset;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return defaultToolset;
}
