/**
 * Resolve backend base URL across runtimes:
 *  - Vite dev (5173): empty → proxied to :3847
 *  - Production (served by backend on :3847): empty → same origin
 *  - Custom host: set VITE_API_BASE at build time or window.__PINODES_ORCHESTRA_API__
 */
function resolveBase(): string {
  if (typeof window === "undefined") {
    return process.env.VITE_API_BASE ?? "http://localhost:3847";
  }

  const runtime = (window as { __PINODES_ORCHESTRA_API__?: string }).__PINODES_ORCHESTRA_API__;
  if (runtime) return runtime.replace(/\/$/, "");

  const envBase = import.meta.env.VITE_API_BASE as string | undefined;
  if (envBase) return envBase.replace(/\/$/, "");

  if (import.meta.env.DEV) return "";

  const { protocol, port } = window.location;
  if (protocol.startsWith("http") && port === "3847") return "";

  return "http://localhost:3847";
}

export const API_BASE = resolveBase();

/** Optional shared secret — only when PINODES_ORCHESTRA_TOKEN is configured server-side. */
export function resolveAuthToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const runtime = (window as { __PINODES_ORCHESTRA_TOKEN__?: string }).__PINODES_ORCHESTRA_TOKEN__;
  if (runtime?.trim()) return runtime.trim();
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("token")?.trim();
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore */
  }
  try {
    const stored = window.localStorage.getItem("PINODES_ORCHESTRA_TOKEN")?.trim();
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  return undefined;
}

function authHeaders(): Record<string, string> {
  const token = resolveAuthToken();
  return token ? { "X-PiNodes-Orchestra-Token": token } : {};
}

/** Build an absolute (or proxied-relative) URL for a backend path. */
export function api(path: string): string {
  return `${API_BASE}${path}`;
}

/** fetch() with optional auth header when a token is available. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(authHeaders())) {
    headers.set(k, v);
  }
  return fetch(api(path), { ...init, headers });
}

/** WebSocket URL for the backend. */
export function wsUrl(): string {
  let url: string;
  if (API_BASE) {
    const base = API_BASE.replace(/^http/, "ws");
    url = `${base}/ws`;
  } else if (import.meta.env.DEV) {
    url = "ws://localhost:3847/ws";
  } else {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    url = `${proto}://${window.location.host}/ws`;
  }
  const token = resolveAuthToken();
  if (!token) return url;
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set("token", token);
  return url.startsWith("ws://") || url.startsWith("wss://")
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
