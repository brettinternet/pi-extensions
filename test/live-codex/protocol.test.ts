import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CONTEXT_CHUNK_BYTES,
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  buildSessionContextAppend,
  chunkLiveContext,
  parseLiveServerEvent,
} from "../../extensions/live-codex/protocol.ts";
import {
  buildLiveSidebandUrl,
  getCodexAccountId,
  parseLiveCallId,
} from "../../extensions/live-codex/transport.ts";

describe("Frameless Bidi protocol", () => {
  test("parses client delegations", () => {
    assert.deepEqual(
      parseLiveServerEvent({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegate_1",
          content: [
            { type: "input_text", text: "Fix the failing test" },
            { type: "ignored", text: "no" },
          ],
        },
      }),
      {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegate_1",
          content: [{ type: "input_text", text: "Fix the failing test" }],
        },
      },
    );
  });

  test("chunks without splitting UTF-8 code points", () => {
    const input = `${"a".repeat(499)}🙂${"b".repeat(501)}`;
    const chunks = chunkLiveContext(input);

    assert.equal(chunks.join(""), input);
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, "utf8") <= CONTEXT_CHUNK_BYTES);
    }
  });

  test("builds the pinned live session and context append", () => {
    assert.deepEqual(buildLiveSessionPayload("instructions", "sol"), {
      model: "gpt-live-1-codex",
      instructions: "instructions",
      audio: { output: { voice: "sol" } },
      delegation: { type: "client" },
    });
    assert.deepEqual(buildSessionContextAppend("image attached", "commentary"), {
      type: "session.context.append",
      channel: "commentary",
      content: [{ type: "input_text", text: "image attached" }],
    });
    assert.deepEqual(buildDelegationContextAppend("delegate_1", "done"), {
      type: "delegation.context.append",
      delegation_item_id: "delegate_1",
      content: [{ type: "input_text", text: "done" }],
    });
  });
});

describe("Codex live transport helpers", () => {
  test("extracts signaling call IDs", () => {
    assert.equal(
      parseLiveCallId(
        "https://api.openai.com/v1/realtime/calls/rtc_abc-123?foo=bar",
      ),
      "rtc_abc-123",
    );
    assert.equal(parseLiveCallId("https://example.com/no-call"), undefined);
    assert.equal(
      buildLiveSidebandUrl("rtc_abc-123"),
      "wss://api.openai.com/v1/live/rtc_abc-123",
    );
  });

  test("extracts the ChatGPT account ID claim", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account_123",
        },
      }),
    ).toString("base64url");
    assert.equal(
      getCodexAccountId(`header.${payload}.signature`),
      "account_123",
    );
  });
});
