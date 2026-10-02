import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readGlobalConfig, resolveServer } from "./config.ts";
import { getBuiltinServers } from "./servers.ts";

/** Check discovery only: never start a server, install packages, or change files. */
export async function diagnoseSetup(workspace: string): Promise<{ text: string; hasIssues: boolean }> {
  const configPath = resolve(getAgentDir(), "pi-lsp.json");
  let config;
  try {
    config = await readGlobalConfig();
  } catch (error) {
    return { text: String(error instanceof Error ? error.message : error), hasIssues: true };
  }
  const lines = [`LSP discovery (config: ${configPath}; optional)`, "Servers are not started; found does not prove server health."];
  let hasIssues = false;
  for (const definition of getBuiltinServers()) {
    if (config.servers[definition.id]?.disabled) {
      lines.push(`${definition.id}: disabled`);
      continue;
    }
    try {
      const server = await resolveServer(definition.extensions[0]!, workspace);
      lines.push(`${definition.id}: found ${JSON.stringify(server.resolvedCommand)}`);
      if (definition.id === "typescript") {
        lines.push(`  tsserver: ${JSON.stringify(server.initializationOptions?.tsserver)}`);
      }
    } catch (error) {
      hasIssues = true;
      lines.push(`${definition.id}: unavailable — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  lines.push("Only servers for languages you use are needed. After changing config, /lsp stop applies it to the next startup.");
  return { text: lines.join("\n"), hasIssues };
}
