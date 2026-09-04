import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUEST_ENV,
  GUEST_WORKSPACE,
  PROTOCOL_VERSION,
  assertGuestPath,
  encodeBrokerRequest,
  parseBrokerResponse,
  resolveGuestPath,
  sanitizeGuestEnv,
} from "../../extensions/colima-sandbox/protocol.ts";

test("JSONL broker protocol accepts fixed responses and rejects mismatches", () => {
  const request = encodeBrokerRequest({ version: PROTOCOL_VERSION, id: "r1", op: "ping", payload: {} });
  assert.equal(request, '{"version":1,"id":"r1","op":"ping","payload":{}}\n');
  assert.deepEqual(parseBrokerResponse('{"version":1,"id":"r1","type":"result","ok":true,"result":{"protocol":1}}'), {
    version: 1,
    id: "r1",
    type: "result",
    ok: true,
    result: { protocol: 1 },
  });
  assert.deepEqual(parseBrokerResponse('{"version":1,"id":"r1","type":"data","data":"aGk="}'), {
    version: 1,
    id: "r1",
    type: "data",
    data: "aGk=",
  });
  assert.throws(() => parseBrokerResponse('{"version":2,"id":"r1","type":"result","ok":true,"result":{}}'), /version mismatch/);
  assert.throws(() => parseBrokerResponse('{"version":1,"id":"r1","type":"data","data":"not base64!"}'), /invalid data/);
  assert.throws(() => parseBrokerResponse('{"version":1,"id":"r1","type":"result","ok":true}'), /invalid response/);
});

test("guest paths are canonical and confined to the workspace", () => {
  assert.equal(resolveGuestPath("src/index.ts"), "/workspace/src/index.ts");
  assert.equal(resolveGuestPath("@src/index.ts"), "/workspace/src/index.ts");
  assert.equal(resolveGuestPath("../other", "/workspace/src"), "/workspace/other");
  assert.throws(() => resolveGuestPath("../../etc/passwd"), /outside/);
  assert.throws(() => assertGuestPath("/etc/passwd"), /outside/);
  assert.throws(() => assertGuestPath("/workspace/./file"), /canonical/);
  assert.throws(() => assertGuestPath("/workspace/a\0b"), /Invalid/);
});

test("guest environment stripping never forwards host values", () => {
  const sanitized = sanitizeGuestEnv({
    ...process.env,
    HOME: "/host/home",
    PATH: "/host/bin",
    AWS_SECRET_ACCESS_KEY: "secret",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    PI_MODEL: "private-model",
  });
  assert.deepEqual(sanitized, GUEST_ENV);
  assert.equal(sanitized.HOME, "/home/node");
  assert.equal(sanitized.PATH.includes("/host"), false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in sanitized, false);
  assert.equal("SSH_AUTH_SOCK" in sanitized, false);
  assert.equal("PI_MODEL" in sanitized, false);
  assert.equal(GUEST_WORKSPACE, "/workspace");
});