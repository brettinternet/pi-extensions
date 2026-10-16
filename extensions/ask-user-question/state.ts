import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { outputSchema, parameters, snapshotSchema, validate } from "./model.js";

export const STATE_ENTRY = "ask-user-question-state";
export const RECOVERY_MESSAGE = "ask-user-question-recovered";
const stateSchema = Type.Object({
  version: Type.Literal(1),
  toolCallId: Type.String(),
  questions: parameters.properties.questions,
  snapshot: snapshotSchema,
  result: Type.Optional(outputSchema),
});
export type QuestionState = Static<typeof stateSchema>;

/** Only the active branch can own a pending questionnaire. */
export function readState(entries: readonly SessionEntry[]): QuestionState | undefined {
  let state: QuestionState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      // Never fall back to an older question when the newest record is invalid.
      state = undefined;
      if (!Value.Check(stateSchema, entry.data)) continue;
      const candidate = entry.data;
      const { questions, snapshot } = candidate;
      try { validate(questions); } catch { continue; }
      if (snapshot.drafts.length !== questions.length || snapshot.tab > (questions.length > 1 ? questions.length : 0) ||
        snapshot.cursor > (questions[snapshot.tab]?.options.length ?? 0) ||
        (snapshot.editing && snapshot.tab >= questions.length) ||
        snapshot.drafts.some((draft, i) => draft.selected.some((index) => index >= questions[i]!.options.length))) continue;
      state = candidate;
    } else if (state && entry.type === "message" && entry.message.role === "toolResult" &&
      entry.message.toolCallId === state.toolCallId && !entry.message.isError && state.result &&
      Value.Check(outputSchema, entry.message.details)) {
      state = undefined;
    } else if (state && entry.type === "custom_message" && entry.customType === RECOVERY_MESSAGE &&
      (entry.details as { toolCallId?: unknown } | undefined)?.toolCallId === state.toolCallId) {
      state = undefined;
    }
  }
  return state ? structuredClone(state) : undefined;
}
