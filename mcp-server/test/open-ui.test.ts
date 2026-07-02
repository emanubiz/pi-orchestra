import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildUiUrl } from "../src/tools/open-ui.js";

describe("buildUiUrl", () => {
  it("builds a deep link with board, cwd, embed and token", () => {
    const config = loadConfig({
      PINODES_ORCHESTRA_URL: "http://127.0.0.1:3847",
      PINODES_ORCHESTRA_TOKEN: "tok",
    });
    expect(buildUiUrl(config, { boardId: "b1", cwd: "/tmp/repo", embed: "hermes-desktop" })).toBe(
      "http://127.0.0.1:3847/?board=b1&cwd=%2Ftmp%2Frepo&embed=hermes-desktop&token=tok",
    );
  });
});
