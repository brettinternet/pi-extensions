import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSandboxBashOperations,
  createSandboxEditOperations,
  createSandboxFindOperations,
  createSandboxLsOperations,
  createSandboxReadOperations,
  createSandboxWriteOperations,
  executeSandboxGrep,
} from "../../extensions/colima-sandbox/operations.ts";
import type { BrokerClient } from "../../extensions/colima-sandbox/broker-client.ts";
import { renderSandboxEditCall } from "../../extensions/colima-sandbox/index.ts";

function fakeBroker() {
  const calls: Array<{ operation: string; payload: unknown }> = [];
  const broker = {
    calls,
    async request<T>(operation: string, payload: unknown, options?: { onData?: (data: Buffer) => void }): Promise<T> {
      calls.push({ operation, payload });
      switch (operation) {
        case "readFile":
          return { data: Buffer.from("hello", "utf8").toString("base64") } as T;
        case "exists":
          return { exists: true } as T;
        case "stat":
          return { isDirectory: true } as T;
        case "readdir":
          return { entries: ["a.ts"] } as T;
        case "find":
          return { paths: ["/workspace/src/a.ts"] } as T;
        case "exec":
          options?.onData?.(Buffer.from("guest output\n"));
          return { exitCode: 0 } as T;
        case "grep":
          return { output: "src/a.ts:1: hit" } as T;
        default:
          return {} as T;
      }
    },
  } as unknown as BrokerClient & { calls: Array<{ operation: string; payload: unknown }> };
  return broker;
}

test("all filesystem and shell operation interfaces route to the guest broker", async () => {
  const broker = fakeBroker();
  const read = createSandboxReadOperations(() => broker);
  const write = createSandboxWriteOperations(() => broker);
  const edit = createSandboxEditOperations(() => broker);
  const ls = createSandboxLsOperations(() => broker);
  const find = createSandboxFindOperations(() => broker);
  const bash = createSandboxBashOperations(() => broker);

  assert.deepEqual(await read.readFile("/workspace/src/a.ts"), Buffer.from("hello"));
  await read.access("/workspace/src/a.ts");
  assert.equal(await read.detectImageMimeType!("/workspace/image.png"), "image/png");
  await write.mkdir("/workspace/src");
  await write.writeFile("/workspace/src/a.ts", "new");
  assert.deepEqual(await edit.readFile("/workspace/src/a.ts"), Buffer.from("hello"));
  await edit.access("/workspace/src/a.ts");
  await edit.writeFile("/workspace/src/a.ts", "edited");
  assert.equal(await ls.exists("/workspace"), true);
  assert.equal((await ls.stat("/workspace")).isDirectory(), true);
  assert.deepEqual(await ls.readdir("/workspace"), ["a.ts"]);
  assert.deepEqual(await find.glob("*.ts", "/workspace/src", { ignore: [], limit: 10 }), ["/workspace/src/a.ts"]);
  const chunks: Buffer[] = [];
  assert.deepEqual(await bash.exec("printf guest", "/workspace", { onData: (chunk) => chunks.push(chunk) }), { exitCode: 0 });
  assert.equal(Buffer.concat(chunks).toString(), "guest output\n");

  assert.deepEqual(
    broker.calls.map(({ operation }) => operation),
    ["readFile", "access", "mkdir", "writeFile", "readFile", "access", "writeFile", "exists", "stat", "readdir", "find", "exec"],
  );
  const execPayload = broker.calls.at(-1)?.payload as { command: string; cwd: string; env: Record<string, string> };
  assert.equal(execPayload.command, "printf guest");
  assert.equal(execPayload.cwd, "/workspace");
  assert.equal("PI_MODEL" in execPayload.env, false);
});

test("edit preview renders arguments without reading the host target", () => {
  const theme = {
    fg: (_color: "toolTitle" | "muted", text: string) => text,
    bold: (text: string) => text,
  };
  const component = renderSandboxEditCall({ path: "/etc/hosts" }, theme);
  assert.deepEqual(component.render(120).map((line) => line.trimEnd()), ["edit /etc/hosts"]);
});

test("grep returns the built-in result shape and rejects host paths before routing", async () => {
  const broker = fakeBroker();
  const result = await executeSandboxGrep(broker, { pattern: "hit", path: ".", limit: 10 }, undefined);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "src/a.ts:1: hit" }],
    details: undefined,
  });
  await assert.rejects(
    () => createSandboxReadOperations(() => broker).readFile("/etc/passwd"),
    /outside/,
  );
  assert.equal(broker.calls.at(-1)?.operation, "grep");
});