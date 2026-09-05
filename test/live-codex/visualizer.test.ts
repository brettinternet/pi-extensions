import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LiveVisualizer } from "../../extensions/live-codex/visualizer.ts";

function createVisualizer(transcriptLimit?: number): LiveVisualizer {
  return new LiveVisualizer(
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
      onDrop() {},
      transcriptLimit,
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
  test("forwards configured app shortcuts without accepting editor input", () => {
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
    assert.equal(visualizer.getText(), "existing draft");
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

    visualizer.setAgentTranscript("I found the issue.");
    visualizer.setUserTranscript("Wait");
    visualizer.setUserTranscript("Wait", true);
    visualizer.setAgentTranscript("Okay, I paused.", true);

    assert.deepEqual(transcriptRows(visualizer), [
      "Agent  I found the issue.",
      "You  Wait",
      "Agent  Okay, I paused.",
    ]);
    assert.doesNotMatch(visualizer.render(80).join("\n"), / Live /);
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
