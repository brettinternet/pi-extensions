import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DOCKER_BIN = "docker" as const;
export const COLIMA_BIN = "colima" as const;
export const DOCKER_CONTEXT = "colima" as const;
export const GUEST_WORKSPACE = "/workspace" as const;
export const SANDBOX_LABEL = "io.pi.colima-sandbox" as const;
export const SANDBOX_LABEL_VALUE = "true" as const;
export const SANDBOX_VERSION = "1" as const;
export const IMAGE_TAG = "pi-colima-sandbox:node-22.19.0-bookworm-v2" as const;
export const SANDBOX_USER = "1000:1000" as const;
export const SANDBOX_CONTAINER_PREFIX = "pi-colima-sandbox" as const;
export const SANDBOX_TOOL_LIST = "read,bash,edit,write,grep,find,ls" as const;

const SANDBOX_DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), "Dockerfile");
const SANDBOX_BUILD_CONTEXT = dirname(SANDBOX_DOCKERFILE);
const TRUSTED_DCG_RELATIVE_PATH = join(".dotfiles", "ai", "pi", "extensions", "dcg-guard.ts");
const GIT_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type SandboxNetwork = "none" | "bridge";

export interface ParsedLauncherArgs {
  network: SandboxNetwork;
  piArgs: string[];
}

export interface WorkingDirectory {
  cwd: string;
  repositoryRoot: string;
}

export class LauncherUsageError extends Error {
  override name = "LauncherUsageError";
}

function commandOutput(value: string | Buffer | null | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

function isWithin(root: string, value: string): boolean {
  const rel = relative(root, value);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function reject(message: string): never {
  throw new LauncherUsageError(message);
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) reject(`${option} requires a value`);
  return value;
}

function validateRepositoryFileArgument(argument: string, cwd: string): void {
  const rawPath = argument.slice(1);
  if (!rawPath) reject("@file arguments must name a file inside the workspace");
  if (rawPath.includes("\0")) reject("@file argument contains an invalid path");

  const candidate = resolve(cwd, rawPath);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    reject(`@file argument does not exist: ${rawPath}`);
  }
  if (!isWithin(cwd, canonical)) {
    reject(`@file argument is outside the workspace: ${rawPath}`);
  }
}

/**
 * Validate only the Pi arguments that are safe to pass to the host process.
 * Resource, extension, tool, trust, and arbitrary host-file options are not
 * forwarded. The nested Pi `--` still means "message arguments" to Pi, so
 * @file inputs are checked against the mounted workspace.
 */
export function validateForwardedPiArgs(piArgs: string[], cwd = process.cwd()): void {
  const valueOptions = new Map<string, (value: string) => void>([
    ["--mode", (value) => {
      if (value !== "text" && value !== "json" && value !== "rpc") reject(`invalid --mode value: ${value}`);
    }],
    ["--provider", (value) => {
      if (!value) reject("--provider requires a non-empty value");
    }],
    ["--model", (value) => {
      if (!value) reject("--model requires a non-empty value");
    }],
    ["--api-key", (value) => {
      if (!value) reject("--api-key requires a non-empty value");
    }],
    ["--thinking", (value) => {
      if (!THINKING_LEVELS.has(value)) reject(`invalid --thinking value: ${value}`);
    }],
    ["--name", (value) => {
      if (!value.trim()) reject("--name requires a non-empty value");
    }],
    ["--session-id", (value) => {
      if (!value) reject("--session-id requires a non-empty value");
    }],
    ["--tui-mode", (value) => {
      if (value !== "regular" && value !== "fullscreen") reject(`invalid --tui-mode value: ${value}`);
    }],
  ]);
  const booleanOptions = new Set([
    "--help",
    "-h",
    "--version",
    "-v",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--no-session",
    "--print",
    "-p",
    "--verbose",
    "--offline",
  ]);

  for (let index = 0; index < piArgs.length; index++) {
    const argument = piArgs[index]!;
    if (argument === "--") {
      for (const message of piArgs.slice(index + 1)) {
        if (message.startsWith("@")) validateRepositoryFileArgument(message, cwd);
      }
      return;
    }
    if (argument.startsWith("@")) {
      validateRepositoryFileArgument(argument, cwd);
      continue;
    }
    if (!argument.startsWith("-")) continue;

    if (booleanOptions.has(argument)) continue;
    const valueOption = valueOptions.get(argument);
    if (valueOption) {
      const value = requireValue(piArgs, index, argument);
      valueOption(value);
      index++;
      continue;
    }

    // Explicitly reject options that can add code, resources, host tools, or
    // trust decisions. Unknown flags are rejected as extension flags too.
    reject(`option is not allowed in pi-sandbox: ${argument}`);
  }
}

export function parseLauncherArgs(argv: string[], cwd = process.cwd()): ParsedLauncherArgs {
  const separator = argv.indexOf("--");
  if (separator === -1) reject("usage: pi-sandbox [--network=unrestricted] -- [normal Pi args]");
  const launcherArgs = argv.slice(0, separator);
  const networkOptions = launcherArgs.filter((argument) => argument === "--network=unrestricted");
  if (networkOptions.length !== launcherArgs.length || networkOptions.length > 1) {
    reject("only --network=unrestricted is accepted before --");
  }
  const piArgs = argv.slice(separator + 1);
  validateForwardedPiArgs(piArgs, cwd);
  return {
    network: networkOptions.length === 1 ? "bridge" : "none",
    piArgs,
  };
}

export function canonicalizeWorkingDirectory(cwd = process.cwd(), home = homedir()): WorkingDirectory {
  let canonicalCwd: string;
  let canonicalHome: string;
  try {
    canonicalCwd = realpathSync(cwd);
    canonicalHome = realpathSync(home);
  } catch {
    throw new Error(`cannot resolve working directory: ${cwd}`);
  }
  if (!statSync(canonicalCwd).isDirectory()) throw new Error(`working directory is not a directory: ${cwd}`);
  if (canonicalCwd === canonicalHome) throw new Error("refusing to sandbox HOME itself");

  const git = spawnSync("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], {
    cwd: canonicalCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (git.error || git.status !== 0) {
    throw new Error("working directory is not inside a Git repository");
  }
  const reportedRoot = commandOutput(git.stdout).trim();
  if (!reportedRoot) throw new Error("Git did not report a repository root");
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(reportedRoot);
  } catch {
    throw new Error("cannot resolve the Git repository root");
  }
  if (!isWithin(repositoryRoot, canonicalCwd)) {
    throw new Error("working directory is outside the Git repository");
  }
  if (canonicalCwd !== repositoryRoot) {
    throw new Error("pi-sandbox must be started from the Git repository root");
  }

  // A linked worktree has a .git file (or an unusual symlink) at its checkout
  // root. Main worktrees have a real .git directory.
  const dotGit = join(repositoryRoot, ".git");
  try {
    if (!lstatSync(dotGit).isDirectory()) {
      throw new Error("linked Git worktrees are not supported");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "linked Git worktrees are not supported") throw error;
    throw new Error("Git repository metadata is unavailable");
  }
  return { cwd: canonicalCwd, repositoryRoot };
}

export function assertCwdStable(expectedCwd: string, actualCwd = process.cwd()): void {
  let canonicalActual: string;
  try {
    canonicalActual = realpathSync(actualCwd);
  } catch {
    throw new Error("working directory disappeared");
  }
  if (canonicalActual !== expectedCwd) throw new Error("working directory changed during sandbox startup");
}

export function findTrustedDcgExtension(home = homedir()): string {
  const candidate = join(home, TRUSTED_DCG_RELATIVE_PATH);
  try {
    if (!lstatSync(candidate).isFile()) throw new Error();
    return realpathSync(candidate);
  } catch {
    throw new Error(`trusted DCG extension is missing: ${candidate}`);
  }
}

export function assertHostExtensionsOutsideWorkspace(cwd: string, extensionPaths: string[]): void {
  for (const extensionPath of extensionPaths) {
    const canonicalExtension = realpathSync(extensionPath);
    if (isWithin(cwd, canonicalExtension)) {
      throw new Error(`refusing to mount host-loaded extension inside the writable workspace: ${canonicalExtension}`);
    }
  }
}

export function buildHostPiArgs(piArgs: string[], dcgExtension: string, colimaExtension: string): string[] {
  return [
    "--no-extensions",
    "--no-approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--extension",
    dcgExtension,
    "--extension",
    colimaExtension,
    "--tools",
    SANDBOX_TOOL_LIST,
    ...piArgs,
  ];
}

export function makeContainerName(pid = process.pid, suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`): string {
  const sanitizedSuffix = suffix.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 80);
  const name = `${SANDBOX_CONTAINER_PREFIX}-${Math.max(1, Math.trunc(pid))}-${sanitizedSuffix || "run"}`;
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error("could not create a valid sandbox container name");
  return name;
}

export function buildDockerRunArgs(cwd: string, network: SandboxNetwork, containerName: string, imageTag: string = IMAGE_TAG): string[] {
  if (!CONTAINER_NAME_PATTERN.test(containerName)) throw new Error("invalid sandbox container name");
  if (network !== "none" && network !== "bridge") throw new Error("invalid sandbox network");
  return [
    "run",
    "--detach",
    "--name",
    containerName,
    "--label",
    `${SANDBOX_LABEL}=${SANDBOX_LABEL_VALUE}`,
    "--label",
    `${SANDBOX_LABEL}.version=${SANDBOX_VERSION}`,
    "--mount",
    `type=bind,src=${cwd},dst=${GUEST_WORKSPACE}`,
    "--network",
    network,
    "--user",
    SANDBOX_USER,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--tmpfs",
    "/run:rw,nosuid,nodev,noexec,size=16m",
    "--tmpfs",
    "/home/node:rw,nosuid,nodev,noexec,size=128m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--env",
    "HOME=/home/node",
    "--env",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "LC_ALL=C.UTF-8",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    "--env",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "--env",
    "GIT_TERMINAL_PROMPT=0",
    "--env",
    "NPM_CONFIG_USERCONFIG=/dev/null",
    imageTag,
  ];
}

export function buildDockerCleanupArgs(containerName: string): string[] {
  if (!CONTAINER_NAME_PATTERN.test(containerName)) throw new Error("invalid sandbox container name");
  return ["rm", "--force", containerName];
}

export function dockerInspectIsSafe(
  inspection: unknown,
  cwd: string,
  network: SandboxNetwork,
  imageTag: string = IMAGE_TAG,
): boolean {
  if (!inspection || typeof inspection !== "object") return false;
  const value = inspection as Record<string, unknown>;
  const config = value.Config;
  const hostConfig = value.HostConfig;
  const state = value.State;
  if (!config || typeof config !== "object" || !hostConfig || typeof hostConfig !== "object") return false;
  if (!state || typeof state !== "object" || (state as Record<string, unknown>).Running !== true) return false;
  const configRecord = config as Record<string, unknown>;
  const hostRecord = hostConfig as Record<string, unknown>;
  if (configRecord.User !== SANDBOX_USER) return false;
  if (configRecord.Image !== imageTag && configRecord.Image !== undefined) return false;
  if (hostRecord.ReadonlyRootfs !== true) return false;
  if (hostRecord.NetworkMode !== network) return false;
  if (hostRecord.PidsLimit !== 256) return false;
  if (hostRecord.Memory !== 2 * 1024 * 1024 * 1024) return false;
  if (hostRecord.NanoCpus !== 2 * 1_000_000_000) return false;

  const capDrop = hostRecord.CapDrop;
  if (!Array.isArray(capDrop) || !capDrop.includes("ALL")) return false;
  const securityOptions = hostRecord.SecurityOpt;
  if (!Array.isArray(securityOptions) || !securityOptions.includes("no-new-privileges:true")) return false;

  const mounts = Array.isArray(value.Mounts) ? value.Mounts : [];
  const hostMounts = mounts.filter((mount) => {
    if (!mount || typeof mount !== "object") return false;
    const type = (mount as Record<string, unknown>).Type;
    return type === "bind" || type === "volume";
  });
  if (hostMounts.length !== 1) return false;
  const workspaceMount = hostMounts[0] as Record<string, unknown>;
  if (workspaceMount.Type !== "bind" || workspaceMount.Destination !== GUEST_WORKSPACE || workspaceMount.RW !== true) return false;
  let source: string;
  try {
    source = realpathSync(String(workspaceMount.Source));
  } catch {
    return false;
  }
  if (source !== cwd) return false;

  const tmpfs = hostRecord.Tmpfs;
  if (!tmpfs || typeof tmpfs !== "object") return false;
  const tmpfsPaths = Object.keys(tmpfs as Record<string, unknown>).sort();
  if (tmpfsPaths.join("|") !== "/home/node|/run|/tmp") return false;

  const labels = configRecord.Labels;
  if (!labels || typeof labels !== "object") return false;
  const labelRecord = labels as Record<string, unknown>;
  return labelRecord[SANDBOX_LABEL] === SANDBOX_LABEL_VALUE && labelRecord[`${SANDBOX_LABEL}.version`] === SANDBOX_VERSION;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runSync(program: string, args: string[], cwd?: string, allowFailure = false): CommandResult {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  const normalized: CommandResult = {
    status: result.status,
    stdout: commandOutput(result.stdout),
    stderr: commandOutput(result.stderr),
    ...(result.error ? { error: result.error } : {}),
  };
  if (!allowFailure && (normalized.error || normalized.status !== 0)) {
    const detail = normalized.stderr.trim() || normalized.error?.message || `exit ${normalized.status}`;
    throw new Error(`${program} failed: ${detail}`);
  }
  return normalized;
}

function runDocker(args: string[], cwd?: string, allowFailure = false): CommandResult {
  return runSync(DOCKER_BIN, ["--context", DOCKER_CONTEXT, ...args], cwd, allowFailure);
}

function assertDigest(value: string, label: string): string {
  const digest = value.trim();
  if (!IMAGE_ID_PATTERN.test(digest)) throw new Error(`${label} did not return a resolved image ID`);
  return digest;
}

function ensureColima(): void {
  runSync(COLIMA_BIN, ["status", "--profile", DOCKER_CONTEXT]);
  runDocker(["info"]);
}

export function buildStaleContainerListArgs(): string[] {
  // Never include created or running sandboxes: another Pi process may own
  // them. Docker's repeated status filters are ORed.
  return [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=${SANDBOX_LABEL}=${SANDBOX_LABEL_VALUE}`,
    "--filter",
    "status=exited",
    "--filter",
    "status=dead",
  ];
}

function cleanStaleContainers(cwd: string): void {
  const listed = runDocker(buildStaleContainerListArgs(), cwd);
  for (const id of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!GIT_ID_PATTERN.test(id)) throw new Error("Docker returned an invalid stale container ID");
    runDocker(["rm", "--force", id], cwd);
  }
}

function ensureImage(cwd: string): { tag: string; id: string } {
  const inspected = runDocker(["image", "inspect", "--format", "{{.Id}}", IMAGE_TAG], cwd, true);
  if (inspected.status === 0 && !inspected.error) {
    return { tag: IMAGE_TAG, id: assertDigest(inspected.stdout, "sandbox image inspection") };
  }
  runDocker(["build", "--pull=false", "--file", SANDBOX_DOCKERFILE, "--tag", IMAGE_TAG, SANDBOX_BUILD_CONTEXT], cwd);
  const afterBuild = runDocker(["image", "inspect", "--format", "{{.Id}}", IMAGE_TAG], cwd);
  return { tag: IMAGE_TAG, id: assertDigest(afterBuild.stdout, "sandbox image build") };
}

function inspectContainer(containerName: string, cwd: string, network: SandboxNetwork, imageTag: string): void {
  const output = runDocker(["inspect", "--format", "{{json .}}", containerName], cwd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout.trim());
  } catch {
    throw new Error("Docker returned invalid sandbox inspection JSON");
  }
  if (!dockerInspectIsSafe(parsed, cwd, network, imageTag)) {
    throw new Error("sandbox container security inspection failed");
  }
}

function buildSandboxEnvironment(containerName: string, cwd: string, network: SandboxNetwork, image: { tag: string; id: string }): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // The host Pi deliberately keeps its model credentials. These variables are
  // not sent to the guest; remove Docker/guard overrides from the child so the
  // fixed context and trusted guard path cannot be redirected by ambient env.
  delete childEnv.DCG_BIN;
  delete childEnv.DOCKER_HOST;
  delete childEnv.DOCKER_CONTEXT;
  return {
    ...childEnv,
    PI_COLIMA_SANDBOX_PROTOCOL_VERSION: SANDBOX_VERSION,
    PI_COLIMA_SANDBOX_CONTAINER: containerName,
    PI_COLIMA_SANDBOX_HOST_CWD: cwd,
    PI_COLIMA_SANDBOX_NETWORK: network,
    PI_COLIMA_SANDBOX_IMAGE: image.tag,
    PI_COLIMA_SANDBOX_IMAGE_ID: image.id,
  };
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1) : 1);
      resolvePromise(exitCode);
    });
  });
}

async function runPi(
  piArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  extensions: { dcg: string; colima: string },
  onChild: (child: ChildProcess) => void,
): Promise<number> {
  const args = buildHostPiArgs(piArgs, extensions.dcg, extensions.colima);
  const child = spawn("pi", args, { cwd, env, stdio: "inherit" });
  onChild(child);
  return waitForChild(child);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let containerName: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  let interruptedSignal: NodeJS.Signals | undefined;
  let working: WorkingDirectory | undefined;
  let parsed: ParsedLauncherArgs | undefined;

  const cleanup = (): Promise<void> => {
    if (!containerName || !working) return Promise.resolve();
    cleanupPromise ??= Promise.resolve().then(() => {
      runDocker(buildDockerCleanupArgs(containerName!), working!.cwd);
    });
    return cleanupPromise;
  };

  const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const registeredSignalHandlers = signalHandlers.map((signal) => {
    const handler = () => {
      interruptedSignal = signal;
      if (child && !child.killed) child.kill(signal);
      void cleanup().catch((error) => {
        process.stderr.write(`pi-sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    };
    process.once(signal, handler);
    return { signal, handler };
  });

  try {
    working = canonicalizeWorkingDirectory();
    parsed = parseLauncherArgs(argv, working.cwd);
    assertCwdStable(working.cwd);
    const extensions = {
      dcg: findTrustedDcgExtension(),
      colima: realpathSync(join(SANDBOX_BUILD_CONTEXT, "index.ts")),
    };
    assertHostExtensionsOutsideWorkspace(working.cwd, [extensions.dcg, extensions.colima]);
    ensureColima();
    assertCwdStable(working.cwd);
    cleanStaleContainers(working.cwd);
    const image = ensureImage(working.cwd);
    assertCwdStable(working.cwd);
    containerName = makeContainerName();
    runDocker(buildDockerRunArgs(working.cwd, parsed.network, containerName, image.tag), working.cwd);
    inspectContainer(containerName, working.cwd, parsed.network, image.tag);
    const environment = buildSandboxEnvironment(containerName, working.cwd, parsed.network, image);
    const exitCode = await runPi(parsed.piArgs, working.cwd, environment, extensions, (runningChild) => {
      child = runningChild;
    });
    if (interruptedSignal === "SIGINT") return 130;
    if (interruptedSignal === "SIGTERM") return 143;
    if (interruptedSignal === "SIGHUP") return 129;
    return exitCode;
  } catch (error) {
    process.stderr.write(`pi-sandbox: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    const removeProcessListener = process.off.bind(process) as (event: string, listener: () => void) => NodeJS.Process;
    for (const { signal, handler } of registeredSignalHandlers) removeProcessListener(signal, handler);
    try {
      await cleanup();
    } catch (error) {
      process.stderr.write(`pi-sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === thisFile) {
  main().then((code) => {
    process.exitCode = code;
  });
}