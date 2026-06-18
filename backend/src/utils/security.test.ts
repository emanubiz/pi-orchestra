import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildAllowedOrigins,
  checkAuth,
  routeRequiresAuth,
  validateWebSocketHandshake,
} from "./security.js";

function replyStub() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return reply;
}

describe("buildAllowedOrigins", () => {
  it("includes loopback backend and Vite dev ports", () => {
    const origins = buildAllowedOrigins(3847);
    expect(origins.has("http://127.0.0.1:3847")).toBe(true);
    expect(origins.has("http://localhost:5173")).toBe(true);
  });
});

describe("routeRequiresAuth", () => {
  it("exempts health and static, requires api/internal", () => {
    expect(routeRequiresAuth("/api/health")).toBe(false);
    expect(routeRequiresAuth("/")).toBe(false);
    expect(routeRequiresAuth("/assets/app.js")).toBe(false);
    expect(routeRequiresAuth("/api/prompts")).toBe(true);
    expect(routeRequiresAuth("/internal/ready")).toBe(true);
  });
});

describe("checkAuth", () => {
  beforeEach(() => {
    delete process.env.PINODES_ORCHESTRA_TOKEN;
  });

  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_TOKEN;
  });

  it("allows requests when no token is configured", () => {
    const reply = replyStub();
    expect(checkAuth({ headers: {}, url: "/api/prompts" }, reply as never)).toBe(true);
    expect(reply.statusCode).toBe(200);
  });

  it("accepts the configured token from header, bearer, or querystring", () => {
    process.env.PINODES_ORCHESTRA_TOKEN = "secret";
    expect(
      checkAuth(
        { headers: { "x-pinodes-orchestra-token": "secret" }, url: "/api/prompts" },
        replyStub() as never,
      ),
    ).toBe(true);
    expect(
      checkAuth(
        { headers: { authorization: "Bearer secret" }, url: "/api/prompts" },
        replyStub() as never,
      ),
    ).toBe(true);
    expect(
      checkAuth({ headers: {}, url: "/api/prompts?token=secret" }, replyStub() as never),
    ).toBe(true);
  });

  it("rejects missing or invalid tokens", () => {
    process.env.PINODES_ORCHESTRA_TOKEN = "secret";
    const reply = replyStub();
    expect(checkAuth({ headers: {}, url: "/api/prompts" }, reply as never)).toBe(false);
    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: "Unauthorized" });
  });
});

describe("validateWebSocketHandshake", () => {
  const allowed = buildAllowedOrigins(3847);

  beforeEach(() => {
    delete process.env.PINODES_ORCHESTRA_TOKEN;
  });

  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_TOKEN;
  });

  it("rejects disallowed browser origins", () => {
    const result = validateWebSocketHandshake(
      { headers: { origin: "http://evil.com" }, url: "/ws" },
      allowed,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(4001);
  });

  it("accepts allowed origins without token when unset", () => {
    const result = validateWebSocketHandshake(
      { headers: { origin: "http://127.0.0.1:3847" }, url: "/ws" },
      allowed,
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts connections without Origin when no token (local CLI)", () => {
    const result = validateWebSocketHandshake({ headers: {}, url: "/ws" }, allowed);
    expect(result).toEqual({ ok: true });
  });

  it("requires token when configured", () => {
    process.env.PINODES_ORCHESTRA_TOKEN = "secret";
    const bad = validateWebSocketHandshake(
      { headers: { origin: "http://127.0.0.1:3847" }, url: "/ws" },
      allowed,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe(4002);

    const good = validateWebSocketHandshake(
      { headers: { origin: "http://127.0.0.1:3847" }, url: "/ws?token=secret" },
      allowed,
    );
    expect(good).toEqual({ ok: true });
  });
});
