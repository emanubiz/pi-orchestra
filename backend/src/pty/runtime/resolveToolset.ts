const DEFAULT_TOOLSET = "read,bash,edit,write,grep";

/**
 * Resolve the tool list a runtime passes on its command line: the `toolset`
 * field of the node's `runtimeConfig` when set to a non-empty string,
 * otherwise the shared default. Any other type (or an absent/blank value) is
 * ignored rather than passed through — runtimeConfig is untyped, user-edited
 * JSON reaching a spawned CLI's argv.
 */
export function resolveToolset(runtimeConfig: Record<string, unknown> | undefined): string {
  const configured = runtimeConfig?.toolset;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return DEFAULT_TOOLSET;
}
