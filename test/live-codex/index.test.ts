import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import piLiveCodex, {
  combineRestoredDrafts,
  LIVE_TRANSCRIPT_LIMIT_FLAG,
  parseTranscriptLimit,
} from "../../extensions/live-codex/index.ts";

test("restores pre-live drafts and pending notes in a deterministic order", () => {
  assert.equal(combineRestoredDrafts("draft", "typed note"), "draft\n\ntyped note");
  assert.equal(
    combineRestoredDrafts("draft", "typed note", "unfinished"),
    "draft\n\ntyped note\n\nunfinished",
  );
  assert.equal(combineRestoredDrafts("", "typed note"), "typed note");
});

test("parses the live transcript limit as a positive safe integer", () => {
  assert.equal(parseTranscriptLimit(undefined), 4);
  assert.equal(parseTranscriptLimit(" 12 "), 12);

  for (const value of ["", "0", "-1", "1.5", "1e2", "9007199254740992", false]) {
    assert.throws(
      () => parseTranscriptLimit(value),
      /--live-transcript-limit must be a positive integer/,
    );
  }
});

test("registers the string limit flag and rejects invalid values before voice starts", async () => {
  let flagName: string | undefined;
  let flagOptions: Parameters<ExtensionAPI["registerFlag"]>[1] | undefined;
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let flagValue: string | undefined = "not-a-number";
  const notifications: string[] = [];
  let editorChanged = false;
  const pi = {
    registerFlag: (name: string, options: Parameters<ExtensionAPI["registerFlag"]>[1]) => {
      flagName = name;
      flagOptions = options;
    },
    getFlag: (name: string) => {
      assert.equal(name, LIVE_TRANSCRIPT_LIMIT_FLAG);
      return flagValue;
    },
    registerCommand: (_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      command = options;
    },
    registerShortcut: () => {},
    on: () => {},
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI;

  piLiveCodex(pi);

  assert.equal(flagName, LIVE_TRANSCRIPT_LIMIT_FLAG);
  assert.deepEqual(flagOptions, {
    type: "string",
    description: "Number of live transcript utterances to retain",
    default: "4",
  });
  assert.deepEqual(command!.getArgumentCompletions?.("mar"), [
    { value: "marin", label: "marin", description: "Realtime voice" },
  ]);
  assert.deepEqual(command!.getArgumentCompletions?.("sol"), [
    { value: "sol", label: "sol", description: "Default voice" },
  ]);

  const context = {
    mode: "tui",
    ui: {
      notify: (message: string) => notifications.push(message),
      getEditorComponent: () => undefined,
      getEditorText: () => "",
      setEditorComponent: () => {
        editorChanged = true;
      },
      setEditorText: () => {
        editorChanged = true;
      },
      setStatus: () => {
        editorChanged = true;
      },
    },
  } as unknown as ExtensionCommandContext;
  await command!.handler("", context);

  assert.deepEqual(notifications, [
    "--live-transcript-limit must be a positive integer",
  ]);
  assert.equal(editorChanged, false);
});
