import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Set to a source checkout containing the upstream registry and reload fix.
const source = process.env.PI_SUBAGENTS_TEST_SOURCE;
for (const order of ["producer-first", "consumer-first"]) {
  for (const lifecycle of ["completion", "reload"]) {
    test.skipIf(!source)(`real SDK + subagents: ${order}, ${lifecycle}`, () => {
      const result = spawnSync("node", ["--experimental-strip-types", fileURLToPath(new URL("./subagents-sdk.mjs", import.meta.url)), source!, order, lifecycle], {
        encoding: "utf8", timeout: 30_000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('"parentProcessed":true');
    }, 35_000);
  }
}
