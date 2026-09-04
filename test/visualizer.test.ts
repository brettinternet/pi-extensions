import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LiveVisualizer } from "../extensions/visualizer.ts";

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
      { fg: (_color: string, text: string) => text } as never,
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
      { fg: (_color: string, text: string) => text } as never,
      {
        onStop() {},
        onToggleMute() {},
        onDrop: (data) => drops.push(data),
      },
    );

    visualizer.handleInput("\x1b[200~/tmp/screenshot.png\x1b[201~");

    assert.deepEqual(drops, ["\x1b[200~/tmp/screenshot.png\x1b[201~"]);
  });

  test("wraps the complete input transcript", () => {
    const visualizer = new LiveVisualizer(
      { requestRender() {} } as never,
      {} as never,
      {} as never,
      { fg: (_color: string, text: string) => text } as never,
      { onStop() {}, onToggleMute() {}, onDrop() {} },
    );
    const transcript = "one two three four five six";

    visualizer.setTranscript(transcript);
    const rows = visualizer.render(12);
    const transcriptRows = rows.slice(3, -1);

    assert.ok(transcriptRows.length > 1);
    assert.equal(
      transcriptRows.map((row) => row.slice(1, -1).trimEnd()).join(" "),
      transcript,
    );
    assert.ok(transcriptRows.every((row) => visibleWidth(row) === 12));
  });
});
