import { describe, expect, test } from "bun:test";
import { configPath, DEFAULT_CONFIG, parseConfig } from "../../extensions/progress/config.ts";

describe("progress inference configuration", () => {
  test("is disabled by default and honors the Pi agent directory", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.model).toBeNull();
    expect(configPath({ PI_CODING_AGENT_DIR: "/tmp/pi-test" })).toBe("/tmp/pi-test/pi-progress.json");
  });

  test("accepts only an explicit model and known fields", () => {
    expect(parseConfig({ model: " openai/gpt-5-nano:off ", maxTokens: 90 })).toEqual({
      ...DEFAULT_CONFIG,
      model: "openai/gpt-5-nano:off",
      maxTokens: 90,
    });
    expect(() => parseConfig({ model: "auto" })).toThrow("not supported");
    expect(() => parseConfig({ model: "" })).toThrow("must not be empty");
    expect(() => parseConfig({ enabled: true })).toThrow("unknown configuration field");
    expect(() => parseConfig({ timeoutMs: 0 })).toThrow("positive integer");
  });
});
