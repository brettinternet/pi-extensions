import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LiveVisualizer, type LiveVisualizerOptions } from "../../extensions/live-codex/visualizer.ts";

function createVisualizer(
  transcriptLimit?: number,
  overrides: Partial<LiveVisualizerOptions> = {},
): LiveVisualizer {
  return new LiveVisualizer(
    { requestRender() {}, terminal: { rows: 24 } } as never,
    { borderColor: (text: string) => text, selectList: {} } as never,
    { matches: () => false, getKeys: () => [] } as never,
    {
      fg: (_color: string, text: string) => text,
      inverse: (text: string) => text,
    } as never,
    {
      onStop() {},
      onToggleMute() {},
      onDrop() {},
      transcriptLimit,
      ...overrides,
    },
  );
}

function transcriptRows(visualizer: LiveVisualizer, width = 80): string[] {
  return visualizer
    .render(width)
    .filter((row) => row.includes(" You ") || row.includes(" Agent "))
    .map((row) => row.slice(1, -1).trim());
}

describe("Live visualizer", () => {
  test("opens the inherited editor for printable input and keeps it hidden when empty", () => {
    const visualizer = createVisualizer();

    assert.equal(visualizer.render(40).length, 4);
    visualizer.handleInput("x");

    assert.equal(visualizer.getText(), "x");
    assert.ok(visualizer.render(40).length > 4);
    visualizer.handleInput("\x7f");
    assert.equal(visualizer.getText(), "");
    assert.equal(visualizer.render(40).length, 4);
  });

  test("uses bare space for mute only while the editor is empty", () => {
    let muted = 0;
    const visualizer = createVisualizer(undefined, {
      onToggleMute: () => muted++,
    });

    visualizer.handleInput(" ");
    assert.equal(muted, 1);
    assert.equal(visualizer.getText(), "");

    visualizer.handleInput("x");
    visualizer.handleInput(" ");
    assert.equal(muted, 1);
    assert.equal(visualizer.getText(), "x ");
  });

  test("stages verbatim multiline text without invoking normal submission", () => {
    const submitted: string[] = [];
    const notes: string[] = [];
    const visualizer = createVisualizer(undefined, {
      onTypedNote: (text) => notes.push(text),
    });
    visualizer.onSubmit = (text) => submitted.push(text);
    visualizer.setText("first line\n  const value = 1;\n");

    visualizer.handleInput("\n");

    assert.deepEqual(notes, ["first line\n  const value = 1;\n"]);
    assert.deepEqual(submitted, []);
    assert.equal(visualizer.getText(), "");
  });

  test("renders the inherited editor for attachments even without text", () => {
    const visualizer = createVisualizer();

    visualizer.setAttachmentCount(1);

    assert.ok(visualizer.render(40).length > 4);
  });

  test("forwards configured app shortcuts and accepts editor input", () => {
    let expanded = 0;
    const visualizer = new LiveVisualizer(
      { requestRender() {} } as never,
      {} as never,
      {
        matches(data: string, action: string) {
          return data === "ctrl+e" && action === "app.tools.expand";
        },
      } as never,
      {
        fg: (_color: string, text: string) => text,
        inverse: (text: string) => text,
      } as never,
      { onStop() {}, onToggleMute() {}, onDrop() {} },
    );
    visualizer.onAction("app.tools.expand", () => expanded++);
    visualizer.setText("existing draft");

    visualizer.handleInput("ctrl+e");
    visualizer.handleInput("x");

    assert.equal(expanded, 1);
    assert.equal(visualizer.getText(), "existing draftx");
  });

  test("forwards dropped files", () => {
    const drops: string[] = [];
    const visualizer = new LiveVisualizer(
      { requestRender() {} } as never,
      {} as never,
      {} as never,
      {
        fg: (_color: string, text: string) => text,
        inverse: (text: string) => text,
      } as never,
      {
        onStop() {},
        onToggleMute() {},
        onDrop: (data) => drops.push(data),
      },
    );

    visualizer.handleInput("\x1b[200~/tmp/screenshot.png\x1b[201~");

    assert.deepEqual(drops, ["\x1b[200~/tmp/screenshot.png\x1b[201~"]);
  });

  test("wraps and labels the complete input transcript", () => {
    const visualizer = createVisualizer();
    const transcript = "one two three four five six";

    visualizer.setUserTranscript(transcript, true);
    const rows = visualizer.render(12);
    const renderedTranscriptRows = rows.slice(3, -1);

    assert.ok(renderedTranscriptRows.length > 1);
    assert.equal(
      renderedTranscriptRows.map((row) => row.slice(1, -1).trimEnd()).join(" "),
      ` You  ${transcript}`,
    );
    assert.ok(renderedTranscriptRows.every((row) => visibleWidth(row) === 12));
  });

  test("renders finalized utterances in chronological order", () => {
    const visualizer = createVisualizer();

    visualizer.setUserTranscript("first request", true);
    visualizer.setAgentTranscript("first response", true);
    visualizer.setUserTranscript("second request", true);
    visualizer.setAgentTranscript("second response", true);

    assert.deepEqual(transcriptRows(visualizer), [
      "You  first request",
      "Agent  first response",
      "You  second request",
      "Agent  second response",
    ]);
  });

  test("replaces partial transcript text and finalizes it in place", () => {
    const visualizer = createVisualizer();

    visualizer.setUserTranscript("I wan");
    assert.deepEqual(transcriptRows(visualizer), ["You  I wan"]);

    visualizer.setUserTranscript("I want to run checks");
    assert.deepEqual(transcriptRows(visualizer), ["You  I want to run checks"]);

    visualizer.setUserTranscript("Run checks in this repo", true);
    assert.deepEqual(transcriptRows(visualizer), ["You  Run checks in this repo"]);

    visualizer.setAgentTranscript("I will run them.", true);
    assert.deepEqual(transcriptRows(visualizer), [
      "You  Run checks in this repo",
      "Agent  I will run them.",
    ]);
  });

  test("keeps interruptions in spoken order", () => {
    const visualizer = createVisualizer();

    visualizer.setAgentTranscript("I found the issue.", false, true);
    visualizer.setUserTranscript("Wait", false, true);
    visualizer.setUserTranscript("Wait", true);
    visualizer.setAgentTranscript("Okay, I paused.", true, true);

    assert.deepEqual(transcriptRows(visualizer), [
      "Agent  I found the issue.",
      "You  Wait",
      "Agent  Okay, I paused.",
    ]);
    assert.doesNotMatch(visualizer.render(80).join("\n"), / Live /);
  });

  test("consolidates interleaved partial and finalized role streams", () => {
    const visualizer = createVisualizer();

    visualizer.setUserTranscript("Report to me the result", false, true);
    visualizer.setAgentTranscript("Let me check that", false, true);
    visualizer.setUserTranscript(
      "Report to me the result results when they get back",
    );
    visualizer.setUserTranscript(
      "Report to me the results when they get back",
      true,
    );
    visualizer.setAgentTranscript("Let me check that quickly.", true);

    assert.deepEqual(transcriptRows(visualizer), [
      "You  Report to me the results when they get back",
      "Agent  Let me check that quickly.",
    ]);
  });

  test("trims by utterance count rather than wrapped terminal rows", () => {
    const visualizer = createVisualizer();

    for (let index = 1; index <= 5; index += 1) {
      visualizer.setUserTranscript(
        `utterance-${index} has enough words to wrap across rows`,
        true,
      );
    }

    const rendered = visualizer.render(18).join("\n");
    assert.doesNotMatch(rendered, /utterance-1/);
    for (let index = 2; index <= 5; index += 1) {
      assert.match(rendered, new RegExp(`utterance-${index}`));
    }
    assert.equal(transcriptRows(visualizer, 18).length, 4);
  });

  test("uses a configured transcript utterance limit", () => {
    const visualizer = createVisualizer(2);

    visualizer.setUserTranscript("old", true);
    visualizer.setAgentTranscript("middle", true);
    visualizer.setUserTranscript("new", true);

    assert.deepEqual(transcriptRows(visualizer), [
      "Agent  middle",
      "You  new",
    ]);
  });
});
