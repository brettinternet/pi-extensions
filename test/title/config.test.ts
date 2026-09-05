import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  saveConfig,
} from "../../extensions/title/config.js";

describe("configuration", () => {
  test("uses the Pi agent directory override", () => {
    expect(configPath({ PI_CODING_AGENT_DIR: "/tmp/custom-pi" })).toBe(
      "/tmp/custom-pi/pi-title.jsonc",
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

  test("loads JSONC comments and trailing commas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-title-config-"));
    const path = join(directory, "pi-title.jsonc");
    await writeFile(path, '{\n  // Use a cheap model.\n  "model": "auto",\n}\n');

    expect(await loadConfig(path)).toEqual({ ...DEFAULT_CONFIG, model: "auto" });
  });

  test("falls back to JSON but gives JSONC precedence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-title-config-"));
    const env = { PI_CODING_AGENT_DIR: directory };
    await writeFile(join(directory, "pi-title.json"), '{ "model": "auto" }\n');

    expect(await loadConfig(undefined, env)).toEqual({ ...DEFAULT_CONFIG, model: "auto" });

    await writeFile(join(directory, "pi-title.jsonc"), '{ "enabled": false }\n');
    expect(await loadConfig(undefined, env)).toEqual({ ...DEFAULT_CONFIG, enabled: false });
  });

  test("preserves comments when commands update the config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-title-config-"));
    const path = join(directory, "pi-title.jsonc");
    await writeFile(path, '{\n  // Keep this explanation.\n  "enabled": true\n}\n');

    await saveConfig({ ...DEFAULT_CONFIG, enabled: false }, path);

    const contents = await readFile(path, "utf8");
    expect(contents).toContain("// Keep this explanation.");
    expect(await loadConfig(path)).toEqual({ ...DEFAULT_CONFIG, enabled: false });
  });
});
