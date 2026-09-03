import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LiveVisualizer } from "../extensions/visualizer.ts";

describe("Live visualizer", () => {
  test("wraps the complete input transcript", () => {
    const visualizer = new LiveVisualizer(
      { requestRender() {} } as never,
      {} as never,
      {} as never,
      { fg: (_color: string, text: string) => text } as never,
      { onStop() {}, onToggleMute() {} },
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
