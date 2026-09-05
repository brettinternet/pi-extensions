import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../../extensions/progress/config.ts";
import {
  inferenceFromCompletion,
  inferenceOptions,
  inferenceRequest,
  parseInference,
  resolveInferenceModel,
} from "../../extensions/progress/inference.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const model = { provider: "openai", id: "gpt-5-nano", reasoning: true } as Model;

function modelContext(authenticated = true) {
  return {
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => authenticated,
    },
  } as unknown as Pick<ExtensionContext, "modelRegistry">;
}

const valid = {
  phase: "Verification",
  current: "Checking profile configuration",
  completed: ["Configured FleetView"],
  blocked: [],
  confidence: 0.91,
};

describe("progress inference model resolution", () => {
  test("resolves only the exact explicit model and checks authentication", () => {
    expect(resolveInferenceModel(modelContext(), "openai/gpt-5-nano")).toEqual({ model, thinkingLevel: "off" });
    expect(resolveInferenceModel(modelContext(), "openai/gpt-5-nano:minimal")).toEqual({ model, thinkingLevel: "minimal" });
    expect(() => resolveInferenceModel(modelContext(), "openai/nano")).toThrow("unavailable");
    expect(() => resolveInferenceModel(modelContext(false), "openai/gpt-5-nano")).toThrow("not authenticated");
  });

  test("uses fresh uncached requests and defaults reasoning off", () => {
    const first = inferenceOptions(DEFAULT_CONFIG, "off");
    const second = inferenceOptions(DEFAULT_CONFIG, "off");
    expect(first.cacheRetention).toBe("none");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first).not.toHaveProperty("reasoning");
    expect(inferenceOptions(DEFAULT_CONFIG, "minimal")).toMatchObject({ reasoning: "minimal" });
  });
});

describe("progress inference contract", () => {
  test("normalizes a valid bounded object", () => {
    expect(parseInference({ ...valid, phase: " Verification\n" })).toEqual(valid);
    expect(inferenceFromCompletion({ content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`` }], stopReason: "stop" })).toEqual(valid);
  });

  test("rejects unknown, missing, oversized, low-confidence, and invalid output", () => {
    expect(() => parseInference({ ...valid, verified: true })).toThrow("missing or unknown");
    const { blocked: _blocked, ...missing } = valid;
    expect(() => parseInference(missing)).toThrow("missing or unknown");
    expect(() => parseInference({ ...valid, completed: ["a", "b", "c", "d"] })).toThrow("at most three");
    expect(() => parseInference({ ...valid, phase: "x".repeat(49) })).toThrow("1-48");
    expect(() => parseInference({ ...valid, confidence: 0.2 })).toThrow("too low");
    expect(() => parseInference({ ...valid, phase: "Verified" })).toThrow("cannot claim verification");
    expect(() => parseInference({ ...valid, phase: "\u001b[2JVerification" })).toThrow("terminal control");
    expect(() => inferenceFromCompletion({ content: [{ type: "text", text: "not json" }], stopReason: "stop" })).toThrow("invalid JSON");
    expect(() => inferenceFromCompletion({ content: [{ type: "text", text: JSON.stringify(valid) }], stopReason: "error" })).toThrow("did not complete successfully");
    expect(() => inferenceFromCompletion({ content: [], stopReason: "length" })).toThrow("did not complete successfully");
    expect(() => inferenceFromCompletion({ content: [], stopReason: "stop" })).toThrow("no usable text");
  });

  test("truncates the digest at the configured input boundary", () => {
    const request = inferenceRequest(
      { request: "x".repeat(1_000), events: [], touchedPaths: [], checks: [] },
      { ...DEFAULT_CONFIG, maxInputChars: 120 },
    );
    const text = (request.messages[0].content as Array<{ text: string }>)[0].text;
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).not.toContain("system prompt");
  });
});
