import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { BrokerClient } from "./broker-client.ts";
import {
  createSandboxBashOperations,
  createSandboxEditOperations,
  createSandboxFindOperations,
  createSandboxLsOperations,
  createSandboxReadOperations,
  createSandboxWriteOperations,
  executeSandboxGrep,
} from "./operations.ts";
import { GUEST_WORKSPACE, IMAGE_TAG, PROTOCOL_VERSION } from "./protocol.ts";
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const NETWORKS = new Set(["none", "bridge"]);

type SandboxNetwork = "none" | "bridge";

interface RuntimeConfig {
  containerName: string;
  hostCwd: string;
  network: SandboxNetwork;
  imageTag: string;
  imageId: string;
}

function envValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`sandbox launcher variable ${name} is missing`);
  return value;
}

function readRuntimeConfig(hostCwd: string): RuntimeConfig {
  const protocol = envValue("PI_COLIMA_SANDBOX_PROTOCOL_VERSION");
  if (protocol !== String(PROTOCOL_VERSION)) throw new Error("sandbox launcher protocol version mismatch");
  const containerName = envValue("PI_COLIMA_SANDBOX_CONTAINER");
  if (!CONTAINER_NAME_PATTERN.test(containerName)) throw new Error("sandbox launcher supplied an invalid container name");
  const configuredCwd = envValue("PI_COLIMA_SANDBOX_HOST_CWD");
  if (configuredCwd !== hostCwd) throw new Error("sandbox launcher cwd mismatch");
  const network = envValue("PI_COLIMA_SANDBOX_NETWORK");
  if (!NETWORKS.has(network)) throw new Error("sandbox launcher supplied an invalid network");
  const imageTag = envValue("PI_COLIMA_SANDBOX_IMAGE");
  if (imageTag !== IMAGE_TAG) throw new Error("sandbox launcher supplied an unexpected image");
  const imageId = envValue("PI_COLIMA_SANDBOX_IMAGE_ID");
  if (!IMAGE_ID_PATTERN.test(imageId)) throw new Error("sandbox launcher supplied an invalid image ID");
  return { containerName, hostCwd: configuredCwd, network: network as SandboxNetwork, imageTag, imageId };
}

function assertStableCwd(hostCwd: string, ctx: ExtensionContext): void {
  if (ctx.cwd !== hostCwd) throw new Error("Pi working directory drifted from the sandbox workspace");
  let current: string;
  try {
    current = realpathSync(process.cwd());
  } catch {
    throw new Error("Pi working directory disappeared");
  }
  if (current !== hostCwd) throw new Error("Pi working directory changed during the sandbox session");
}

type EditRenderTheme = {
  fg(color: "toolTitle" | "muted", text: string): string;
  bold(text: string): string;
};

export function renderSandboxEditCall(args: { path?: unknown }, theme: EditRenderTheme): Text {
  const target = typeof args.path === "string" ? args.path : "<invalid path>";
  return new Text(`${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("muted", target)}`, 0, 0);
}

function imageMimeType(value: string): string | null {
  const extension = path.posix.extname(value).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".bmp") return "image/bmp";
  return null;
}

export default function colimaSandbox(pi: ExtensionAPI): void {
  let hostCwd: string;
  try {
    hostCwd = realpathSync(process.cwd());
  } catch {
    throw new Error("cannot resolve the sandbox host working directory");
  }
  const config = readRuntimeConfig(hostCwd);
  let broker: BrokerClient | undefined;
  let starting: Promise<BrokerClient> | undefined;

  const getBroker = (): BrokerClient => {
    if (!broker) throw new Error("sandbox broker is not ready");
    return broker;
  };

  const ensureBroker = async (ctx: ExtensionContext): Promise<BrokerClient> => {
    assertStableCwd(hostCwd, ctx);
    if (broker) return broker;
    if (!starting) {
      starting = (async () => {
        const candidate = new BrokerClient({ containerName: config.containerName });
        try {
          await candidate.start();
          await candidate.ping();
          broker = candidate;
          return candidate;
        } catch (error) {
          await candidate.stop().catch(() => {});
          throw error;
        }
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  };

  const readOperations: ReadOperations = createSandboxReadOperations(getBroker);
  // The MIME helper is intentionally local and pure; bytes still come only
  // from the guest broker.
  readOperations.detectImageMimeType = async (absolutePath) => imageMimeType(absolutePath);
  const writeOperations: WriteOperations = createSandboxWriteOperations(getBroker);
  const editOperations: EditOperations = createSandboxEditOperations(getBroker);
  const bashOperations: BashOperations = createSandboxBashOperations(getBroker);
  const findOperations: FindOperations = createSandboxFindOperations(getBroker);
  const lsOperations: LsOperations = createSandboxLsOperations(getBroker);

  const readTool = createReadTool(GUEST_WORKSPACE, { operations: readOperations });
  const writeTool = createWriteTool(GUEST_WORKSPACE, { operations: writeOperations });
  const editTool = createEditTool(GUEST_WORKSPACE, { operations: editOperations });
  const bashTool = createBashTool(GUEST_WORKSPACE, {
    operations: bashOperations,
    exposeSessionEnvironment: false,
  });
  const findTool = createFindTool(GUEST_WORKSPACE, { operations: findOperations });
  const lsTool = createLsTool(GUEST_WORKSPACE, { operations: lsOperations });
  const grepTool = createGrepTool(GUEST_WORKSPACE);

  pi.registerTool({
    ...readTool,
    async execute(id, params, signal, onUpdate, ctx) {
      await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return readTool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...writeTool,
    async execute(id, params, signal, onUpdate, ctx) {
      await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return writeTool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...editTool,
    // Pi's built-in edit preview reads the target with the host filesystem.
    // Replace it so even a rejected absolute path cannot disclose host data.
    renderCall(args, theme) {
      return renderSandboxEditCall(args, theme);
    },
    async execute(id, params, signal, onUpdate, ctx) {
      await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return editTool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...bashTool,
    async execute(id, params, signal, onUpdate, ctx) {
      await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...grepTool,
    async execute(_id, params: GrepToolInput, signal, _onUpdate, ctx) {
      const activeBroker = await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return executeSandboxGrep(activeBroker, params, signal);
    },
  });
  pi.registerTool({
    ...findTool,
    async execute(id, params, signal, onUpdate, ctx) {
      await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return findTool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...lsTool,
    async execute(id, params, signal, onUpdate, ctx) {
      await ensureBroker(ctx);
      assertStableCwd(hostCwd, ctx);
      return lsTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    await ensureBroker(ctx);
    assertStableCwd(hostCwd, ctx);
    return { operations: bashOperations };
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureBroker(ctx);
      ctx.ui.setStatus("colima-sandbox", ctx.ui.theme.fg("accent", "Colima sandbox: active"));
    } catch (error) {
      ctx.ui.notify(`Colima sandbox failed closed: ${error instanceof Error ? error.message : String(error)}`, "error");
      ctx.shutdown();
      throw error;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const pendingStart = starting;
    if (pendingStart) await pendingStart.catch(() => {});
    const activeBroker = broker;
    broker = undefined;
    starting = undefined;
    await activeBroker?.stop();
    ctx.ui.setStatus("colima-sandbox", undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureBroker(ctx);
    assertStableCwd(hostCwd, ctx);
    const guestLine = "Current working directory: /workspace (Colima sandbox; repository workspace only)";
    let replaced = false;
    const systemPrompt = event.systemPrompt
      .split("\n")
      .map((line) => {
        if (!line.startsWith("Current working directory:")) return line;
        replaced = true;
        return guestLine;
      })
      .join("\n");
    return { systemPrompt: replaced ? systemPrompt : `${systemPrompt}\n\n${guestLine}` };
  });

  pi.registerCommand("sandbox", {
    description: "Show Colima sandbox status",
    handler: async (_args, ctx) => {
      try {
        await ensureBroker(ctx);
        ctx.ui.notify(
          [
            `Container: ${config.containerName}`,
            `Image: ${config.imageTag} (${config.imageId})`,
            "Mount: current repository -> /workspace (read-write)",
            `Network: ${config.network === "none" ? "none" : "unrestricted (bridge)"}`,
            "Boundary: Colima container; non-root, read-only root, no host credentials or Docker socket",
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Colima sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}