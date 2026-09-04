import { basename } from "node:path";

export type CommandRiskCategory =
  | "delete"
  | "deploy"
  | "git-mutation"
  | "package-publish"
  | "process-system"
  | "shell-wrapper"
  | "unknown-executable";

export interface CommandRisk {
  category: CommandRiskCategory;
  reason: string;
}

const SHELLS = new Set([
  "ash", "bash", "cmd", "csh", "dash", "fish", "ksh", "nu", "powershell", "pwsh", "sh", "tcsh", "zsh",
]);
const INTERPRETERS = new Set([
  "deno", "lua", "node", "perl", "php", "python", "python2", "python3", "ruby",
]);
const WRAPPERS_AND_TASK_RUNNERS = new Set([
  "ant", "command", "exec", "gmake", "gradle", "gradlew", "just", "make", "mise", "mvn", "mvnw",
  "nice", "ninja", "nohup", "parallel", "rake", "task", "timeout", "watch", "xargs",
]);
const READ_ONLY_COMMANDS = new Set([
  "basename", "cat", "cmp", "comm", "cut", "df", "dirname", "du", "echo", "false", "head", "jq", "ls",
  "md5", "md5sum", "nl", "od", "paste", "printf", "pwd", "realpath", "sha1sum", "sha256sum", "stat",
  "tail", "tr", "true", "uname", "uniq", "wc", "which", "whoami",
]);
const DESTRUCTIVE_FILESYSTEM = new Set([
  "chmod", "chown", "dd", "mkfs", "mv", "rmdir", "rm", "shred", "truncate", "unlink",
]);
const DESTRUCTIVE_SYSTEM = new Set([
  "doas", "halt", "kill", "killall", "pkill", "poweroff", "reboot", "service", "shutdown", "sudo", "systemctl",
]);
const READ_ONLY_GIT = new Set([
  "diff", "log", "ls-files", "rev-parse", "show", "status",
]);
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const READ_ONLY_DEPLOY_COMMANDS: Record<string, ReadonlySet<string>> = {
  kubectl: new Set(["api-resources", "api-versions", "describe", "explain", "get", "logs", "version"]),
  helm: new Set(["env", "get", "history", "list", "search", "show", "status", "version"]),
  terraform: new Set(["graph", "output", "show", "validate", "version"]),
  pulumi: new Set(["about", "logs", "version", "whoami"]),
  flyctl: new Set(["logs", "status", "version"]),
  vercel: new Set(["inspect", "list", "logs", "whoami"]),
};

function executable(command: string): string {
  return basename(command).toLowerCase().replace(/\.exe$/, "");
}

function firstOperand(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
}

function gitOperation(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") || arg.startsWith("--super-prefix=") ||
      arg.startsWith("--config-env=") || arg === "--no-pager" || arg === "--paginate" ||
      arg === "--literal-pathspecs" || arg === "--glob-pathspecs" ||
      arg === "--noglob-pathspecs" || arg === "--icase-pathspecs") continue;
    if (arg === "--version" || arg === "--help") return arg;
    if (arg.startsWith("-")) return undefined;
    return arg.toLowerCase();
  }
  return undefined;
}

function nestedOperation(args: readonly string[], parent: string): string | undefined {
  const parentIndex = args.findIndex((arg) => arg.toLowerCase() === parent);
  return parentIndex < 0 ? undefined : firstOperand(args.slice(parentIndex + 1));
}

/**
 * Strict allowlist policy for direct argv execution. Only recognized read-only commands and
 * narrowly defined routine development operations run without confirmation. Wrappers,
 * interpreters, task runners, and unknown executables fail closed to confirmation.
 */
export function classifyCommandRisk(command: readonly string[]): CommandRisk | undefined {
  const name = command[0] ? executable(command[0]) : "";
  const args = command.slice(1);
  if (!name) return { category: "process-system", reason: "empty executable" };

  if (name === "env" || SHELLS.has(name) || INTERPRETERS.has(name) ||
    /^python\d+(?:\.\d+)?$/.test(name) || WRAPPERS_AND_TASK_RUNNERS.has(name)) {
    return { category: "shell-wrapper", reason: `${name} can execute another command, script, or task` };
  }
  if (DESTRUCTIVE_FILESYSTEM.has(name)) {
    return { category: "delete", reason: `${name} can destructively modify the filesystem` };
  }
  if (DESTRUCTIVE_SYSTEM.has(name)) {
    return { category: "process-system", reason: `${name} can stop processes or mutate system services` };
  }
  if (name === "git") {
    const operation = gitOperation(args);
    const unsafeReadOption = args.find((arg) =>
      arg === "--ext-diff" || arg === "--textconv" || arg === "--output" || arg.startsWith("--output="));
    if (!unsafeReadOption && operation &&
      (READ_ONLY_GIT.has(operation) || operation === "--version" || operation === "--help")) return undefined;
    const detail = unsafeReadOption ?? operation ?? "with unrecognized options";
    return { category: "git-mutation", reason: `git ${detail} is not on the read-only allowlist` };
  }
  if (PACKAGE_MANAGERS.has(name) && args.some((arg) => arg.toLowerCase() === "publish")) {
    return { category: "package-publish", reason: `${name} publish releases a package` };
  }
  if ((name === "cargo" && firstOperand(args) === "publish") ||
    (name === "gem" && ["publish", "push"].includes(firstOperand(args) ?? "")) ||
    (name === "twine" && firstOperand(args) === "upload") ||
    (name === "nuget" && firstOperand(args) === "push") ||
    (name === "dotnet" && args[0]?.toLowerCase() === "nuget" && args[1]?.toLowerCase() === "push")) {
    return { category: "package-publish", reason: `${name} publishes a package` };
  }
  if (name === "gh" && firstOperand(args) === "release" && nestedOperation(args, "release") === "create") {
    return { category: "package-publish", reason: "gh release create publishes a GitHub release" };
  }
  const deployReads = READ_ONLY_DEPLOY_COMMANDS[name];
  if (deployReads) {
    const operation = args[0]?.toLowerCase();
    if (operation && deployReads.has(operation)) return undefined;
    return { category: "deploy", reason: `${name} ${operation ?? "operation"} may mutate deployment or infrastructure state` };
  }
  if (["ansible-playbook", "cdk", "serverless", "sls"].includes(name)) {
    return { category: "deploy", reason: `${name} may mutate deployment or infrastructure state` };
  }
  if (name === "find") {
    const destructiveAction = args.find((arg) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]
        .includes(arg.toLowerCase()));
    if (destructiveAction) {
      return { category: "delete", reason: `find ${destructiveAction} can modify the filesystem or execute another command` };
    }
    return undefined;
  }
  if (name === "fd") {
    const executionOption = args.find((arg) =>
      arg.startsWith("-x") || arg.startsWith("-X") || arg === "--exec" || arg.startsWith("--exec=") ||
      arg === "--exec-batch" || arg.startsWith("--exec-batch="));
    if (!executionOption) return undefined;
    return { category: "shell-wrapper", reason: `fd ${executionOption} executes another command` };
  }
  if (name === "rg") {
    const executionOption = args.find((arg) => arg === "--pre" || arg.startsWith("--pre="));
    if (!executionOption) return undefined;
    return { category: "shell-wrapper", reason: `rg ${executionOption} executes another command` };
  }
  if (name === "sort") {
    const unsafeOption = args.find((arg) =>
      arg.startsWith("-o") || arg === "--output" || arg.startsWith("--output=") ||
      arg === "--compress-program" || arg.startsWith("--compress-program="));
    if (!unsafeOption) return undefined;
    return { category: "delete", reason: `sort ${unsafeOption} can overwrite a file or execute another program` };
  }
  if (name === "date") {
    const setOption = args.find((arg) => arg.startsWith("-s") || arg === "--set" || arg.startsWith("--set="));
    if (!setOption) return undefined;
    return { category: "process-system", reason: `date ${setOption} can change the system clock` };
  }
  if (name === "bun" && firstOperand(args) === "test") return undefined;
  if (READ_ONLY_COMMANDS.has(name)) return undefined;
  return { category: "unknown-executable", reason: `${name} is not on the direct-command allowlist` };
}
