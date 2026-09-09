import { describe, expect, test } from "bun:test";
import {
  progressHistory,
  progressHistoryLines,
} from "../../extensions/progress/history.ts";
import { INFERENCE_ENTRY } from "../../extensions/progress/index.ts";

const first = {
  phase: "Implementation",
  current: "Updated the progress display",
  completed: ["Retained stale inference"],
  blocked: [],
  confidence: 0.9,
};
const second = {
  phase: "Verification",
  current: "Reviewed the session",
  completed: ["Ran progress tests"],
  blocked: ["Browser unavailable"],
  confidence: 0.8,
};

describe("progress history", () => {
  test("reads valid settled inference from the current branch in order", () => {
    const history = progressHistory([
      { type: "custom", customType: INFERENCE_ENTRY, data: first },
      { type: "custom", customType: "unrelated", data: second },
      { type: "custom", customType: INFERENCE_ENTRY, data: { phase: "invalid" } },
      { type: "custom", customType: INFERENCE_ENTRY, data: second },
    ], INFERENCE_ENTRY);

    expect(history).toEqual([first, second]);
  });

  test("lists each run with its completed steps and blockers", () => {
    expect(progressHistoryLines([first, second])).toEqual([
      { kind: "run", text: "1. Implementation · Updated the progress display" },
      { kind: "completed", text: "Retained stale inference" },
      { kind: "run", text: "2. Verification · Reviewed the session" },
      { kind: "completed", text: "Ran progress tests" },
      { kind: "blocked", text: "Browser unavailable" },
    ]);
  });
});
