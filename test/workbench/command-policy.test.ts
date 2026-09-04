import { describe, expect, test } from "bun:test";
import { classifyCommandRisk } from "../../extensions/workbench/command-policy.ts";

const category = (command: string[]): string | undefined => classifyCommandRisk(command)?.category;

describe("workbench command risk policy", () => {
  test("allows ordinary tests and read-only Git", () => {
    expect(category(["bun", "test"])).toBeUndefined();
    expect(category(["/usr/bin/git", "status", "--short"])).toBeUndefined();
    expect(category(["git", "-C", "/repo", "diff", "--cached"])).toBeUndefined();
    expect(category(["git", "log", "--oneline"])).toBeUndefined();
  });

  test("confirms Git mutations and unknown Git operations", () => {
    expect(category(["git", "commit", "-m", "message"])).toBe("git-mutation");
    expect(category(["git", "push", "origin", "main"])).toBe("git-mutation");
    expect(category(["git", "branch"])).toBe("git-mutation");
  });

  test("confirms shell, deletion, deployment, and publishing surfaces", () => {
    expect(category(["bash", "-lc", "echo ok"])).toBe("shell-wrapper");
    expect(category(["env", "MODE=test", "sh", "-c", "echo ok"])).toBe("shell-wrapper");
    expect(category(["rm", "-rf", "build"])).toBe("delete");
    expect(category(["kubectl", "apply", "-f", "deployment.yaml"])).toBe("deploy");
    expect(category(["helm", "upgrade", "app", "chart"])).toBe("deploy");
    expect(category(["terraform", "apply"])).toBe("deploy");
    expect(category(["pulumi", "up"])).toBe("deploy");
    expect(category(["flyctl", "deploy"])).toBe("deploy");
    expect(category(["vercel", "--prod"])).toBe("deploy");
    expect(category(["bun", "publish"])).toBe("package-publish");
    expect(category(["gh", "release", "create", "v1.0.0"])).toBe("package-publish");
  });

  test("allows explicit read operations on deployment clients", () => {
    expect(category(["kubectl", "get", "pods"])).toBeUndefined();
    expect(category(["helm", "status", "app"])).toBeUndefined();
    expect(category(["terraform", "plan"])).toBeUndefined();
  });
});
