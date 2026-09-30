import { Type, type Static } from "typebox";

export const parameters = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ minLength: 1 }),
    header: Type.String({ minLength: 1, maxLength: 16 }),
    options: Type.Array(Type.Object({
      label: Type.String({ minLength: 1, maxLength: 60 }),
      description: Type.String({ minLength: 1 }),
      preview: Type.Optional(Type.String()),
    }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false });
export type Question = Static<typeof parameters>["questions"][number];
export const outputSchema = Type.Object({
  cancelled: Type.Boolean(),
  answers: Type.Array(Type.Object({
    question: Type.String(),
    header: Type.String(),
    selected: Type.Array(Type.String()),
    custom: Type.String(),
  })),
});
export type Result = Static<typeof outputSchema>;
export interface Draft { selected: Set<number>; custom: string }

export function validate(questions: Question[]): void {
  for (const q of questions) {
    if (!q.question.trim() || !q.header.trim()) throw new Error("Question and header must not be blank.");
    const labels = new Set<string>();
    for (const option of q.options) {
      const label = option.label.trim().toLowerCase().replace(/[.!]+$/, "");
      if (!label || !option.description.trim()) throw new Error("Options require non-blank labels and descriptions.");
      if (["other", "type something"].includes(label)) throw new Error("Do not author Other or Type something: a custom-answer row is appended automatically.");
      if (labels.has(label)) throw new Error("Option labels must be distinct within each question.");
      labels.add(label);
      if (q.multiSelect && option.preview !== undefined) throw new Error("Previews are supported only for single-select questions.");
    }
  }
}

export const newDrafts = (questions: Question[]): Draft[] => questions.map(() => ({ selected: new Set<number>(), custom: "" }));
export const answered = (draft: Draft): boolean => draft.selected.size > 0 || !!draft.custom.trim();
export function select(q: Question, draft: Draft, index: number): void {
  if (q.multiSelect) {
    if (draft.selected.has(index)) draft.selected.delete(index);
    else draft.selected.add(index);
  } else {
    draft.selected = new Set([index]);
    draft.custom = "";
  }
}
export function result(questions: Question[], drafts: Draft[], cancelled: boolean): Result {
  return { cancelled, answers: cancelled ? [] : questions.map((q, i) => ({
    question: q.question, header: q.header,
    selected: q.options.filter((_, index) => drafts[i]!.selected.has(index)).map((o) => o.label),
    custom: drafts[i]!.custom.trim(),
  })) };
}
export function summary(value: Result): string {
  return value.cancelled ? "User cancelled the questionnaire. No answers were submitted." : value.answers.map((a) =>
    `${a.header}: ${[...a.selected, ...(a.custom ? [`User wrote: ${a.custom}`] : [])].join("; ")}`,
  ).join("\n");
}
