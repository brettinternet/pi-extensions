import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
  IMAGE_TAG,
  SANDBOX_LABEL,
  SANDBOX_TOOL_LIST,
  assertCwdStable,
  assertHostExtensionsOutsideWorkspace,
  buildDockerCleanupArgs,
  buildDockerRunArgs,
  buildStaleContainerListArgs,
  buildHostPiArgs,
  canonicalizeWorkingDirectory,
  dockerInspectIsSafe,
  makeContainerName,
  parseLauncherArgs,
  validateForwardedPiArgs,
} from "../../extensions/colima-sandbox/launcher.ts";

function indexOfPair(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1]!;
}

test("launcher requires a separator and accepts only the unrestricted network override", () => {
  assert.deepEqual(parseLauncherArgs(["--", "--model", "gpt-5"]), {
    network: "none",
    piArgs: ["--model", "gpt-5"],
  });
  assert.deepEqual(parseLauncherArgs(["--network=unrestricted", "--", "--continue"]), {
    network: "bridge",
    piArgs: ["--continue"],
  });
  assert.throws(() => parseLauncherArgs(["--model", "gpt-5"]), /usage/);
  assert.throws(() => parseLauncherArgs(["--network=none", "--"]), /only --network/);
  assert.throws(() => parseLauncherArgs(["--network=unrestricted", "--network=unrestricted", "--"]), /only --network/);
});

test("launcher rejects host-surface and tool-selection arguments", () => {
  for (const argument of [
    "--extension",
    "--no-extensions",
    "--approve",
    "--no-approve",
    "--tools",
    "--exclude-tools",
    "--no-tools",
    "--no-builtin-tools",
    "--skill",
    "--prompt-template",
    "--theme",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--system-prompt",
    "--append-system-prompt",
    "--session",
    "--fork",
    "--session-dir",
    "--export",
    "--list-models",
    "--unknown-extension-flag",
  ]) {
    assert.throws(() => validateForwardedPiArgs([argument, "value"]), new RegExp(argument.replaceAll("-", "\\-")));
  }
  validateForwardedPiArgs(["--provider", "openai", "--model", "gpt-5", "--thinking", "high", "--continue"]);
});

test("host Pi argv is fixed to the trusted extensions and sandbox tools", () => {
  const args = buildHostPiArgs(["--model", "gpt-5"], "/trusted/dcg-guard.ts", "/repo/extensions/colima-sandbox/index.ts");
  assert.deepEqual(args.slice(0, 6), [
    "--no-extensions",
    "--no-approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
  ]);
  assert.deepEqual(args.slice(6, 10), [
    "--extension",
    "/trusted/dcg-guard.ts",
    "--extension",
    "/repo/extensions/colima-sandbox/index.ts",
  ]);
  assert.equal(indexOfPair(args, "--tools"), SANDBOX_TOOL_LIST);
  assert.deepEqual(args.slice(-2), ["--model", "gpt-5"]);
});

test("Docker run security flags, mount shape, cleanup, and network modes are fixed", () => {
  const none = buildDockerRunArgs("/repo/project", "none", makeContainerName(42, "test"));
  const bridge = buildDockerRunArgs("/repo/project", "bridge", makeContainerName(42, "test-2"));
  assert.equal(indexOfPair(none, "--network"), "none");
  assert.equal(indexOfPair(bridge, "--network"), "bridge");
  assert.equal(indexOfPair(none, "--mount"), "type=bind,src=/repo/project,dst=/workspace");
  assert.equal(indexOfPair(none, "--user"), "1000:1000");
  assert.ok(none.includes("--read-only"));
  assert.ok(none.includes("--cap-drop") && none.includes("ALL"));
  assert.ok(none.includes("--security-opt") && none.includes("no-new-privileges:true"));
  assert.equal(indexOfPair(none, "--pids-limit"), "256");
  assert.equal(indexOfPair(none, "--memory"), "2g");
  assert.equal(indexOfPair(none, "--cpus"), "2");
  assert.equal(none.filter((value) => value === "--tmpfs").length, 3);
  assert.ok(none.includes(`${SANDBOX_LABEL}=true`));
  assert.ok(none.includes(IMAGE_TAG));
  assert.deepEqual(buildDockerCleanupArgs("pi-colima-sandbox-42-test"), ["rm", "--force", "pi-colima-sandbox-42-test"]);
  const staleArgs = buildStaleContainerListArgs();
  assert.ok(staleArgs.includes("status=exited"));
  assert.ok(staleArgs.includes("status=dead"));
  assert.equal(staleArgs.includes("status=created"), false);
  assert.equal(staleArgs.includes("status=running"), false);
});

test("working directory and cwd drift checks canonicalize safely", () => {
  const working = canonicalizeWorkingDirectory(process.cwd(), homedir());
  assert.equal(working.cwd, process.cwd());
  assertCwdStable(working.cwd, process.cwd());
  assert.throws(() => canonicalizeWorkingDirectory(homedir(), homedir()), /HOME/);
  assert.throws(() => canonicalizeWorkingDirectory("test", homedir()), /repository root/);
  assert.throws(() => assertCwdStable(working.cwd, homedir()), /changed|drifted/);
});

test("host-loaded extensions cannot live inside the writable workspace", () => {
  assert.throws(
    () => assertHostExtensionsOutsideWorkspace(process.cwd(), [`${process.cwd()}/extensions/colima-sandbox/index.ts`]),
    /host-loaded extension/,
  );
  assert.doesNotThrow(() => assertHostExtensionsOutsideWorkspace(process.cwd(), [process.execPath]));
});

test("Docker inspection rejects a changed boundary", () => {
  const safe = {
    Config: {
      User: "1000:1000",
      Image: IMAGE_TAG,
      Labels: {
        [SANDBOX_LABEL]: "true",
        [`${SANDBOX_LABEL}.version`]: "1",
      },
    },
    State: { Running: true },
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: "none",
      PidsLimit: 256,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2 * 1_000_000_000,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw", "/run": "rw", "/home/node": "rw" },
    },
    Mounts: [{ Type: "bind", Source: process.cwd(), Destination: "/workspace", RW: true }],
  };
  assert.equal(dockerInspectIsSafe(safe, process.cwd(), "none"), true);
  assert.equal(dockerInspectIsSafe({ ...safe, HostConfig: { ...safe.HostConfig, NetworkMode: "bridge" } }, process.cwd(), "none"), false);
  assert.equal(dockerInspectIsSafe({ ...safe, Mounts: [{ ...safe.Mounts[0], RW: false }] }, process.cwd(), "none"), false);
});