import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { jsonBody, orchestraRequest, OrchestraHttpError } from "../src/http.js";

describe("orchestraRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends token and parses JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const config = loadConfig({ PINODES_ORCHESTRA_TOKEN: "tok" });
    await expect(orchestraRequest(config, "/api/health")).resolves.toEqual({ ok: true });
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("X-PiNodes-Orchestra-Token")).toBe("tok");
  });

  it("throws useful API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad graph" }), { status: 400 }),
    );
    const config = loadConfig({});
    await expect(orchestraRequest(config, "/bad")).rejects.toMatchObject({
      name: "OrchestraHttpError",
      status: 400,
      message: "bad graph",
    } satisfies Partial<OrchestraHttpError>);
  });
});

describe("jsonBody", () => {
  it("stringifies payloads", () => {
    expect(jsonBody({ a: 1 })).toBe('{"a":1}');
  });
});
