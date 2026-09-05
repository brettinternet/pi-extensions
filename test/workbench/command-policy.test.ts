import { describe, expect, test } from "bun:test";
import { classifyCommandRisk } from "../../extensions/workbench/command-policy.ts";

const category = (command: string[]): string | undefined => classifyCommandRisk(command)?.category;

describe("workbench command risk policy", () => {
  test("allows recognized read-only commands and exact routine test runners", () => {
    expect(category(["bun", "test"])).toBeUndefined();
    expect(category(["pytest", "tests", "-q"])).toBeUndefined();
    expect(category(["python", "-m", "unittest", "discover", "-v"])).toBeUndefined();
    expect(category(["python2", "-m", "pytest", "tests"])).toBeUndefined();
    expect(category(["/usr/bin/python3.12", "-m", "unittest"])).toBeUndefined();
    expect(category(["task", "check"])).toBeUndefined();
    expect(category(["make", "test", "build"])).toBeUndefined();
    expect(category(["bun", "run", "typecheck"])).toBeUndefined();
    expect(category(["cargo", "check"])).toBeUndefined();
    expect(category(["go", "test", "./..."])).toBeUndefined();
    expect(category(["rg", "TODO", "src"])).toBeUndefined();
    expect(category(["find", ".", "-name", "*.ts"])).toBeUndefined();
    expect(category(["/usr/bin/git", "status", "--short"])).toBeUndefined();
    expect(category(["git", "-C", "/repo", "diff", "--cached"])).toBeUndefined();
    expect(category(["git", "log", "--oneline"])).toBeUndefined();
  });

  test("confirms Git mutations, unsafe output options, and unknown Git operations", () => {
    expect(category(["git", "commit", "-m", "message"])).toBe("git-mutation");
    expect(category(["git", "push", "origin", "main"])).toBe("git-mutation");
    expect(category(["git", "branch"])).toBe("git-mutation");
    expect(category(["git", "diff", "--output=/tmp/result"])).toBe("git-mutation");
    expect(category(["git", "diff", "--ext-diff"])).toBe("git-mutation");
  });

  test("confirms shells, interpreters, wrappers, task runners, and unknown executables", () => {
    expect(category(["bash", "-lc", "echo ok"])).toBe("shell-wrapper");
    expect(category(["python"])).toBe("shell-wrapper");
    expect(category(["python", "-c", "print('ok')"])).toBe("shell-wrapper");
    expect(category(["python", "script.py"])).toBe("shell-wrapper");
    expect(category(["python", "-m", "unittest.discover"])).toBe("shell-wrapper");
    expect(category(["python", "-m", "coverage"])).toBe("shell-wrapper");
    expect(category(["python", "-B", "-m", "unittest"])).toBe("shell-wrapper");
    expect(category(["python3.12", "-m", "pytest.ini"])).toBe("shell-wrapper");
    expect(category(["env", "MODE=test", "rg", "TODO"])).toBe("shell-wrapper");
    expect(category(["mise", "exec", "git", "--", "push"])).toBe("shell-wrapper");
    expect(category(["task", "check", "deploy"])).toBe("shell-wrapper");
    expect(category(["make", "install"])).toBe("shell-wrapper");
    expect(category(["bun", "run", "release"])).toBe("unknown-executable");
    expect(category(["xargs", "rm"])).toBe("shell-wrapper");
    expect(category(["make", "deploy"])).toBe("shell-wrapper");
    expect(category(["fd", "-e", "tmp", "-x", "rm"])).toBe("shell-wrapper");
    expect(category(["rg", "--pre=rm", "needle", "target"])).toBe("shell-wrapper");
    expect(category(["project-tool", "check"])).toBe("unknown-executable");
  });

  test("confirms deletion, deployment, and publishing surfaces", () => {
    expect(category(["rm", "-rf", "build"])).toBe("delete");
    expect(category(["find", ".", "-delete"])).toBe("delete");
    expect(category(["find", ".", "-fprintf", "output", "%p\\n"])).toBe("delete");
    expect(category(["sort", "-o", "target", "source"])).toBe("delete");
    expect(category(["sort", "--compress-program=rm", "source"])).toBe("delete");
    expect(category(["kubectl", "apply", "-f", "deployment.yaml"])).toBe("deploy");
    expect(category(["kubectl", "--namespace", "get", "delete", "pod", "victim"])).toBe("deploy");
    expect(category(["helm", "upgrade", "app", "chart"])).toBe("deploy");
    expect(category(["terraform", "apply"])).toBe("deploy");
    expect(category(["pulumi", "up"])).toBe("deploy");
    expect(category(["flyctl", "deploy"])).toBe("deploy");
    expect(category(["flyctl", "ips", "allocate-v4"])).toBe("deploy");
    expect(category(["terraform", "fmt"])).toBe("deploy");
    expect(category(["terraform", "providers", "lock"])).toBe("deploy");
    expect(category(["vercel", "--prod"])).toBe("deploy");
    expect(category(["bun", "publish"])).toBe("package-publish");
    expect(category(["gh", "release", "create", "v1.0.0"])).toBe("package-publish");
  });

  test("allows explicit read operations on deployment clients", () => {
    expect(category(["kubectl", "get", "pods"])).toBeUndefined();
    expect(category(["helm", "status", "app"])).toBeUndefined();
    expect(category(["terraform", "show"])).toBeUndefined();
  });
});
