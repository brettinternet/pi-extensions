import { describe, expect, test } from "bun:test";
import { configPath, DEFAULT_CONFIG, parseConfig } from "../../extensions/title/config.js";

describe("configuration", () => {
  test("uses the Pi agent directory override", () => {
    expect(configPath({ PI_CODING_AGENT_DIR: "/tmp/custom-pi" })).toBe(
      "/tmp/custom-pi/pi-title.json",
    );
  });

  test("applies defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("normalizes configured values", () => {
    expect(
      parseConfig({ enabled: false, model: " openai/gpt-5-nano ", maxTokens: 20, maxLength: 48 }),
    ).toEqual({ enabled: false, model: "openai/gpt-5-nano", maxTokens: 20, maxLength: 48 });
  });

  test("defaults an omitted model to the active session model", () => {
    expect(parseConfig({}).model).toBeNull();
    expect(parseConfig({ model: null }).model).toBeNull();
    expect(parseConfig({ model: "auto" }).model).toBe("auto");
  });

  test("rejects invalid model values", () => {
    expect(() => parseConfig({ model: 42 })).toThrow('"model" must be a provider/model string or null');
  });
});
