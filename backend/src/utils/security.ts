import type { FastifyReply, FastifyRequest } from "fastify";

const WS_CLOSE_ORIGIN = 4001;
const WS_CLOSE_UNAUTHORIZED = 4002;

/** Default browser origins allowed to talk to the backend (loopback + Vite dev). */
export function buildAllowedOrigins(port: number): Set<string> {
  const origins = new Set<string>([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  const extra = process.env.PINODES_ORCHESTRA_ALLOWED_ORIGINS?.trim();
  if (extra) {
    for (const o of extra.split(",")) {
      const trimmed = o.trim();
      if (trimmed) origins.add(trimmed);
    }
  }
  return origins;
}

export function isAllowedOrigin(origin: string, allowed: Set<string>): boolean {
  return allowed.has(origin);
}

export function configuredToken(): string | undefined {
  const token = process.env.PINODES_ORCHESTRA_TOKEN?.trim();
  return token || undefined;
}

export function extractAuthToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const header = headers["x-pinodes-orchestra-token"];
  if (typeof header === "string" && header) return header;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const bearer = auth.slice(7).trim();
    if (bearer) return bearer;
  }
  return undefined;
}

export function extractTokenFromUrl(url: string): string | undefined {
  const q = url.indexOf("?");
  if (q === -1) return undefined;
  const token = new URLSearchParams(url.slice(q)).get("token")?.trim();
  return token || undefined;
}

/** REST preHandler: no-op when PINODES_ORCHESTRA_TOKEN is unset. */
export function checkAuth(
  req: Pick<FastifyRequest, "headers" | "url">,
  reply: FastifyReply,
): boolean {
  const expected = configuredToken();
  if (!expected) return true;
  const provided =
    extractAuthToken(req.headers) ?? extractTokenFromUrl(req.url);
  if (provided !== expected) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export type WsHandshakeResult =
  | { ok: true }
  | { ok: false; code: number; reason: string };

/**
 * WebSocket handshake gate: blocks cross-site browser connections (CSWSH).
 * When a token is configured, every connection must present it (?token= or header).
 */
export function validateWebSocketHandshake(
  req: Pick<FastifyRequest, "headers" | "url">,
  allowedOrigins: Set<string>,
): WsHandshakeResult {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const expected = configuredToken();
  const provided =
    extractTokenFromUrl(req.url) ?? extractAuthToken(req.headers);

  if (origin) {
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      return { ok: false, code: WS_CLOSE_ORIGIN, reason: "Origin not allowed" };
    }
  }

  if (expected) {
    if (provided !== expected) {
      return { ok: false, code: WS_CLOSE_UNAUTHORIZED, reason: "Unauthorized" };
    }
  }

  return { ok: true };
}

/** Paths that skip the global auth hook (liveness + static frontend assets). */
export function routeRequiresAuth(urlPath: string): boolean {
  const path = urlPath.split("?")[0] ?? urlPath;
  if (path === "/api/health") return false;
  if (path === "/ws") return false;
  return path.startsWith("/api/") || path.startsWith("/internal/");
}
