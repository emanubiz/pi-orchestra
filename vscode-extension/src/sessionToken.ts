import * as crypto from "node:crypto";

/**
 * Resolve the auth token for this backend session.
 *
 * When the user has configured `pinodesOrchestra.token` in VS Code settings,
 * that value is used as-is. Otherwise an ephemeral random UUID is generated
 * so that every backend spawn is protected even without user configuration.
 *
 * Extracted into a pure function (no vscode dependency) so it can be unit
 * tested without mocking the VS Code API.
 */
export function resolveSessionToken(configured: string | undefined): string {
  const trimmed = configured?.trim();
  return trimmed || crypto.randomUUID();
}
