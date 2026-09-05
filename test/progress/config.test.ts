import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, DEFAULT_CONFIG, loadConfig, parseConfig } from "../../extensions/progress/config.ts";

describe("progress inference configuration", () => {
  test("is disabled by default and honors the Pi agent directory", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.model).toBeNull();
    expect(configPath({ PI_CODING_AGENT_DIR: "/tmp/pi-test" })).toBe("/tmp/pi-test/pi-progress.jsonc");
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

  test("loads JSONC comments and trailing commas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-progress-config-"));
    const path = join(directory, "pi-progress.jsonc");
    await writeFile(path, '{\n  // Use an inexpensive model.\n  "model": "openai/gpt-5-nano",\n}\n');

    expect(await loadConfig(path)).toEqual({ ...DEFAULT_CONFIG, model: "openai/gpt-5-nano" });
  });

  test("falls back to JSON but gives JSONC precedence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-progress-config-"));
    const env = { PI_CODING_AGENT_DIR: directory };
    await writeFile(join(directory, "pi-progress.json"), '{ "model": "openai/legacy" }\n');

    expect(await loadConfig(undefined, env)).toEqual({ ...DEFAULT_CONFIG, model: "openai/legacy" });

    await writeFile(join(directory, "pi-progress.jsonc"), '{ "model": "openai/preferred" }\n');
    expect(await loadConfig(undefined, env)).toEqual({ ...DEFAULT_CONFIG, model: "openai/preferred" });
  });
});
