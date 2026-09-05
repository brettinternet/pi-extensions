import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as progressCompletions from "../extensions/progress/completions.ts";
import * as titleCompletions from "../extensions/title/completions.ts";

const models = [
  {
    provider: "openai",
    id: "gpt-test",
    name: "GPT Test",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: null },
  },
  {
    provider: "example",
    id: "plain",
    name: "Plain",
    reasoning: false,
  },
] as NonNullable<ExtensionContext["model"]>[];

const context = {
  modelRegistry: { getAvailable: () => models },
} as unknown as ExtensionContext;

for (const [name, completions] of [
  ["progress", progressCompletions],
  ["title", titleCompletions],
] as const) {
  describe(`${name} model argument completions`, () => {
    test("filters static candidates while returning full replacement values", () => {
      const candidates = [
        { value: "status", label: "status" },
        { value: "model ", label: "model", searchText: "model configure" },
      ];
      expect(completions.completeArguments("sta", candidates)).toEqual([
        { value: "status", label: "status" },
      ]);
      expect(completions.completeArguments("conf", candidates)).toEqual([
        { value: "model ", label: "model" },
      ]);
    });

    test("completes model names, special values, and supported thinking levels", () => {
      const special = [
        { value: "model off", label: "off", description: "Disable inference" },
      ];
      expect(completions.completeModelArgument("model gpt", context, special)).toEqual([
        {
          value: "model openai/gpt-test",
          label: "openai/gpt-test",
          description: "GPT Test · openai",
        },
      ]);
      expect(completions.completeModelArgument("model of", context, special)).toEqual(special);
      expect(
        completions.completeModelArgument("model openai/gpt-test:x", context, special)?.map(({ value }) => value),
      ).toEqual(["model openai/gpt-test:xhigh"]);
      expect(
        completions.completeModelArgument("model example/plain:", context, special)?.map(({ value }) => value),
      ).toEqual(["model example/plain:off"]);
    });
  });
}
