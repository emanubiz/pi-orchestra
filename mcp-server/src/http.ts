import type { OrchestraMcpConfig } from "./config.js";

export class OrchestraHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "OrchestraHttpError";
  }
}

export async function orchestraRequest<T>(
  config: OrchestraMcpConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (config.token) {
    headers.set("X-PiNodes-Orchestra-Token", config.token);
  }

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = text ? safeJsonParse(text) : {};
    if (!response.ok) {
      const message = extractError(body) ?? `HTTP ${response.status} ${response.statusText}`;
      throw new OrchestraHttpError(message, response.status, body);
    }
    return body as T;
  } catch (err) {
    if (err instanceof OrchestraHttpError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${config.timeoutMs}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function extractError(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return null;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
