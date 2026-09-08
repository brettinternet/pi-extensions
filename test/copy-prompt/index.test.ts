import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piCopyPrompt, {
  copyPromptText,
  COPY_PROMPT_SHORTCUT,
} from "../../extensions/copy-prompt/index.ts";

function testContext(text: string, notifications: Array<[string, string | undefined]>) {
  return {
    ui: {
      getEditorText: () => text,
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push([message, type]);
      },
    },
  } as unknown as Pick<ExtensionContext, "ui">;
}

test("registers an Alt+C shortcut for copying prompt text", () => {
  let shortcut: string | undefined;
  let description: string | undefined;
  const pi = {
    registerShortcut: (key: string, options: { description?: string }) => {
      shortcut = key;
      description = options.description;
    },
  } as unknown as ExtensionAPI;

  piCopyPrompt(pi);

  assert.equal(shortcut, COPY_PROMPT_SHORTCUT);
  assert.equal(description, "Copy the prompt editor text to the clipboard");
});

test("copies the complete editor text and reports success", async () => {
  const notifications: Array<[string, string | undefined]> = [];
  const copied: string[] = [];
  const text = "  first line\nsecond line  ";

  await copyPromptText(testContext(text, notifications), async (value) => {
    copied.push(value);
  });

  assert.deepEqual(copied, [text]);
  assert.deepEqual(notifications, [["Prompt copied to clipboard", "info"]]);
});

test("reports an empty prompt without copying", async () => {
  const notifications: Array<[string, string | undefined]> = [];
  let copied = false;

  await copyPromptText(testContext(" \n\t", notifications), async () => {
    copied = true;
  });

  assert.equal(copied, false);
  assert.deepEqual(notifications, [["Prompt is empty", "warning"]]);
});

test("reports clipboard failures", async () => {
  const notifications: Array<[string, string | undefined]> = [];

  await copyPromptText(testContext("prompt", notifications), async () => {
    throw new Error("clipboard unavailable");
  });

  assert.deepEqual(notifications, [["Failed to copy prompt: clipboard unavailable", "error"]]);
});
