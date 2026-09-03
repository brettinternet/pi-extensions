import { describe, expect, test } from "bun:test";
import {
  CONTEXT_CHUNK_BYTES,
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  chunkLiveContext,
  parseLiveServerEvent,
} from "../extensions/protocol.ts";
import {
  buildLiveSidebandUrl,
  getCodexAccountId,
  parseLiveCallId,
} from "../extensions/transport.ts";

describe("Frameless Bidi protocol", () => {
  test("parses client delegations", () => {
    expect(
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
    ).toEqual({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegate_1",
        content: [{ type: "input_text", text: "Fix the failing test" }],
      },
    });
  });

  test("chunks without splitting UTF-8 code points", () => {
    const input = `${"a".repeat(499)}🙂${"b".repeat(501)}`;
    const chunks = chunkLiveContext(input);

    expect(chunks.join("")).toBe(input);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
        CONTEXT_CHUNK_BYTES,
      );
    }
  });

  test("builds the pinned live session and context append", () => {
    expect(buildLiveSessionPayload("instructions", "sol")).toEqual({
      model: "gpt-live-1-codex",
      instructions: "instructions",
      audio: { output: { voice: "sol" } },
      delegation: { type: "client" },
    });
    expect(buildDelegationContextAppend("delegate_1", "done")).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegate_1",
      content: [{ type: "input_text", text: "done" }],
    });
  });
});

describe("Codex live transport helpers", () => {
  test("extracts signaling call IDs", () => {
    expect(
      parseLiveCallId(
        "https://api.openai.com/v1/realtime/calls/rtc_abc-123?foo=bar",
      ),
    ).toBe("rtc_abc-123");
    expect(parseLiveCallId("https://example.com/no-call")).toBeUndefined();
    expect(buildLiveSidebandUrl("rtc_abc-123")).toBe(
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
    expect(getCodexAccountId(`header.${payload}.signature`)).toBe(
      "account_123",
    );
  });
});
