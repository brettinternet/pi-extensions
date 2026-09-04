import { basename } from "node:path";

export type CommandRiskCategory =
  | "delete"
  | "deploy"
  | "git-mutation"
  | "package-publish"
  | "process-system"
  | "shell-wrapper";

export interface CommandRisk {
  category: CommandRiskCategory;
  reason: string;
}

const SHELLS = new Set([
  "ash", "bash", "cmd", "csh", "dash", "fish", "ksh", "nu", "powershell", "pwsh", "sh", "tcsh", "zsh",
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
  kubectl: new Set([
    "api-resources", "api-versions", "cluster-info", "describe", "explain", "get", "logs", "version",
  ]),
  helm: new Set(["env", "get", "history", "list", "search", "show", "status", "version"]),
  terraform: new Set(["fmt", "graph", "output", "plan", "providers", "show", "validate", "version"]),
  pulumi: new Set(["about", "logs", "preview", "version", "whoami"]),
  flyctl: new Set(["checks", "config", "ips", "logs", "orgs", "platform", "regions", "releases", "status", "version"]),
  vercel: new Set(["bisect", "inspect", "list", "logs", "whoami"]),
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
 * Narrow deny-list policy for direct argv execution. Known mutation surfaces require
 * confirmation; unrecognized direct executables remain allowed and are not treated as shell.
 */
export function classifyCommandRisk(command: readonly string[]): CommandRisk | undefined {
  const name = command[0] ? executable(command[0]) : "";
  const args = command.slice(1);
  if (!name) return { category: "process-system", reason: "empty executable" };

  if (name === "env") {
    let index = 0;
    while (index < args.length) {
      const arg = args[index]!;
      if (arg === "--") {
        index += 1;
        break;
      }
      if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(arg)) {
        index += 2;
        continue;
      }
      if (arg.startsWith("-") || /^[^=]+=/.test(arg)) {
        index += 1;
        continue;
      }
      break;
    }
    return index < args.length ? classifyCommandRisk(args.slice(index)) : undefined;
  }
  if (SHELLS.has(name)) {
    return { category: "shell-wrapper", reason: `${name} can execute an unbounded command string or script` };
  }
  if (DESTRUCTIVE_FILESYSTEM.has(name)) {
    return { category: "delete", reason: `${name} can destructively modify the filesystem` };
  }
  if (DESTRUCTIVE_SYSTEM.has(name)) {
    return { category: "process-system", reason: `${name} can stop processes or mutate system services` };
  }
  if (name === "git") {
    const operation = gitOperation(args);
    if (operation && (READ_ONLY_GIT.has(operation) || operation === "--version" || operation === "--help")) return undefined;
    return { category: "git-mutation", reason: `git ${operation ?? "with unrecognized options"} is not on the read-only allowlist` };
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
    const operation = firstOperand(args);
    if (operation && deployReads.has(operation)) return undefined;
    return { category: "deploy", reason: `${name} ${operation ?? "operation"} may mutate deployment or infrastructure state` };
  }
  if (["ansible-playbook", "cdk", "serverless", "sls"].includes(name)) {
    return { category: "deploy", reason: `${name} may mutate deployment or infrastructure state` };
  }
  return undefined;
}
