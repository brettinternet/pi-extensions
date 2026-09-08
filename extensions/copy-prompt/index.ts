import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const COPY_PROMPT_SHORTCUT = "alt+c" as const;

export async function copyPromptText(
  ctx: Pick<ExtensionContext, "ui">,
  copy: (text: string) => Promise<void> = copyToClipboard,
): Promise<void> {
  const text = ctx.ui.getEditorText();
  if (!text.trim()) {
    ctx.ui.notify("Prompt is empty", "warning");
    return;
  }

  try {
    await copy(text);
    ctx.ui.notify("Prompt copied to clipboard", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to copy prompt: ${message}`, "error");
  }
}

export default function piCopyPrompt(pi: ExtensionAPI): void {
  pi.registerShortcut(COPY_PROMPT_SHORTCUT, {
    description: "Copy the prompt editor text to the clipboard",
    handler: (ctx) => copyPromptText(ctx),
  });
}
