import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { createChatViewport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { Questionnaire } from "../../extensions/ask-user-question/dialog.js";

class TestScreen extends TuiAltScreen {
  flush(): void { this.doRender(); }
}

test("real fullscreen input routes questionnaire scrolling separately from conversation scrolling", () => {
  initTheme("dark", false);
  let input = (_data: string) => {};
  const terminal: Terminal = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {},
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const screen = new TestScreen(terminal, false, undefined, { mouse: true, wheelScrollLines: 3 });
  const ui = new Questionnaire([{
    question: "Which option?", header: "Scroll test", options: [
      { label: "Preview", description: "Long preview", preview: Array.from({ length: 50 }, (_, i) => `Preview line ${i}\n`).join("\n") },
      { label: "No preview", description: "No extra panel" },
    ],
  }], screen, { fg: (_color: string, text: string) => text } as Theme, () => {});
  const document = new Container();
  document.addChild(new Text(Array.from({ length: 80 }, (_, i) => `Agent reply line ${i}`).join("\n"), 0, 0));
  const editor = new Container(); editor.addChild(ui);
  const viewport = createChatViewport({ document, editor, pendingMessages: new Container(), status: new Container(), footer: new Container() });
  screen.setLayoutRoot(viewport.root);
  screen.setFocus(ui);
  screen.start();
  const send = (data: string) => { input(data); screen.flush(); };
  try {
    screen.flush();
    const initial = ui.render(80);
    const transcriptEnd = viewport.transcript.scrollTop;
    // Alt+PageDown must reach the questionnaire, unlike Pi's global PageDown.
    send("\x1b[6;3~");
    expect(ui.render(80)).not.toEqual(initial);
    expect(viewport.transcript.scrollTop).toBe(transcriptEnd);
    send("\x1b[5;3~");
    expect(ui.render(80)).toEqual(initial);
    send("\x1b[6;3~");
    const afterPage = ui.render(80);
    // SGR wheel down over the bottom dock, through Pi's real hit testing.
    send("\x1b[<65;5;20M");
    expect(ui.render(80)).not.toEqual(afterPage);
    expect(viewport.transcript.scrollTop).toBe(transcriptEnd);
    for (let i = 0; i < 40; i++) send("\x1b[<65;5;20M");
    expect(ui.render(80).join("\n")).toContain("Preview line 49");
    expect(viewport.transcript.scrollTop).toBe(transcriptEnd);
    const afterWheel = ui.render(80);
    // Wheel over the reply scrolls the transcript, not the questionnaire.
    send("\x1b[<64;5;2M");
    expect(viewport.transcript.scrollTop).toBeLessThan(transcriptEnd);
    expect(ui.render(80)).toEqual(afterWheel);
    const afterTranscriptWheel = viewport.transcript.scrollTop;
    send("\x1b[5~");
    expect(viewport.transcript.scrollTop).toBeLessThan(afterTranscriptWheel);
    expect(ui.render(80)).toEqual(afterWheel);
    screen.scrollToBottom(); screen.flush();
    expect(viewport.transcript.scrollTop).toBe(transcriptEnd);
    send("\x1d");
    expect(ui.render(80)).toHaveLength(1);
    const collapsedEnd = viewport.transcript.scrollTop;
    send("\x1b[<64;5;2M");
    expect(viewport.transcript.scrollTop).toBeLessThan(collapsedEnd);
    send("\x1d");
    expect(ui.render(80)).toEqual(afterWheel);
    send("j");
    const noPreview = ui.render(80).join("\n");
    expect(noPreview).not.toContain("─ Preview ─");
    expect(noPreview).not.toContain("No preview available");
    expect(noPreview).not.toContain("Notes:");
  } finally {
    ui.dispose();
    screen.stop();
  }
});
