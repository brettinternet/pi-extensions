import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatRuntime, renderProgress } from "../../extensions/progress/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

describe("progress rendering", () => {
  test("formats runtime as one compact unit", () => {
    expect(formatRuntime(0)).toBe("<1m");
    expect(formatRuntime(25 * 60_000)).toBe("25m");
    expect(formatRuntime(90 * 60_000)).toBe("1h");
    expect(formatRuntime(49 * 3_600_000)).toBe("2d");
  });

  test("shows runtime while the session is otherwise idle", () => {
    expect(renderProgress({
      runStarted: false,
      agentActive: false,
      tools: [],
      checks: [],
      touchedPaths: [],
    }, theme, 80, "25m")).toEqual(["progress 25m"]);
  });

  test("renders active work and touched paths in at most two compact lines", () => {
    const lines = renderProgress(
      {
        runStarted: true,
        agentActive: true,
        tools: [
          { id: "1", name: "edit", label: "edit src/a.ts", path: "src/a.ts" },
        ],
        checks: [{ id: "2", label: "bun test", outcome: "passed" }],
        touchedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      },
      theme,
      120,
    );

    expect(lines).toEqual([
      "progress · ● edit src/a.ts · ✓ bun test",
      "touched src/b.ts · src/c.ts · src/d.ts +1",
    ]);
  });

  test("renders settled observed results without retaining an idle empty widget", () => {
    expect(
      renderProgress(
        {
          runStarted: true,
          agentActive: false,
          tools: [],
          checks: [{ id: "1", label: "task check", outcome: "failed" }],
          touchedPaths: [],
        },
        theme,
        80,
      ),
    ).toEqual(["progress · ✓ settled · ✗ task check"]);

    expect(
      renderProgress(
        {
          runStarted: true,
          agentActive: false,
          tools: [],
          checks: [],
          touchedPaths: [],
        },
        theme,
        80,
      ),
    ).toEqual(["progress · ✓ settled"]);

    expect(
      renderProgress(
        {
          runStarted: false,
          agentActive: false,
          tools: [],
          checks: [],
          touchedPaths: [],
        },
        theme,
        80,
      ),
    ).toEqual([]);
  });

  test("drops inferred labels before observed facts on narrow terminals", () => {
    const snapshot = {
      runStarted: true,
      agentActive: true,
      tools: [{ id: "1", name: "edit", label: "edit src/a.ts" }],
      checks: [],
      touchedPaths: [],
      semantic: {
        phase: "Implementation",
        current: "Updating progress inference",
        completed: [],
        blocked: [],
        confidence: 0.9,
      },
    };

    expect(renderProgress(snapshot, theme, 80)).toEqual([
      "progress · current: Updating progress inference inferred · ● edit src/a.ts",
    ]);
    expect(renderProgress(snapshot, theme, 30)).toEqual([
      "progress · ● edit src/a.ts",
    ]);
  });

  test("retains stale active inference dimmed while its replacement updates", () => {
    const lines = renderProgress({
      runStarted: true,
      agentActive: true,
      tools: [],
      checks: [],
      touchedPaths: [],
      semanticStale: true,
      semantic: {
        phase: "Implementation",
        current: "Updating progress inference",
        completed: [],
        blocked: [],
        confidence: 0.9,
      },
    }, theme, 100);

    expect(lines).toEqual([
      "progress · current: Updating progress inference inferred · updating… · ● thinking",
    ]);
  });

  test("renders inference in the brighter warning color", () => {
    const colorTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    } as Theme;
    const lines = renderProgress({
      runStarted: false,
      agentActive: false,
      tools: [],
      checks: [],
      touchedPaths: [],
      semantic: {
        phase: "Implementation",
        current: "Updating progress colors",
        completed: [],
        blocked: [],
        confidence: 0.9,
      },
    }, colorTheme, 120);

    expect(lines[0]).toContain("[warning]current: Updating progress colors inferred[/warning]");
  });

  test("renders restored semantics alone and drops inference before observed facts", () => {
    const semantic = {
      phase: "Verification",
      current: "Checking configuration",
      completed: [],
      blocked: [],
      confidence: 0.9,
    };
    expect(renderProgress({
      runStarted: false,
      agentActive: false,
      tools: [],
      checks: [],
      touchedPaths: [],
      semantic,
    }, theme, 80)).toEqual(["progress · current: Checking configuration inferred"]);

    expect(renderProgress({
      runStarted: true,
      agentActive: true,
      tools: [{ id: "1", name: "edit", label: "edit src/a.ts" }],
      checks: [{ id: "2", label: "bun test", outcome: "passed" }],
      touchedPaths: [],
      semantic,
    }, theme, 45)).toEqual(["progress · ● edit src/a.ts · ✓ bun test"]);
  });

  test("prefers a settled blocker or completed item over the phase", () => {
    const base = {
      runStarted: true,
      agentActive: false,
      tools: [],
      checks: [],
      touchedPaths: [],
    };

    expect(renderProgress({
      ...base,
      semantic: {
        phase: "Verification",
        current: "Waiting for a follow-up",
        completed: ["Updated the progress widget"],
        blocked: [],
        confidence: 0.9,
      },
    }, theme, 100)).toEqual([
      "progress · completed: Updated the progress widget inferred · ✓ settled",
    ]);

    expect(renderProgress({
      ...base,
      semantic: {
        phase: "Verification",
        current: "Waiting for a follow-up",
        completed: ["Updated the progress widget"],
        blocked: ["A required check needs attention"],
        confidence: 0.9,
      },
    }, theme, 100)).toEqual([
      "progress · blocked: A required check needs attention inferred · ✓ settled",
    ]);
  });

  test("prefers inferred settlement over the generic idle label when it is the only detail", () => {
    const lines = renderProgress({
      runStarted: true,
      agentActive: false,
      tools: [],
      checks: [],
      touchedPaths: [],
      semantic: {
        phase: "Verification",
        current: "Waiting for a follow-up",
        completed: ["Completed a long implementation item"],
        blocked: [],
        confidence: 0.9,
      },
    }, theme, 32);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("progress · completed: Complet");
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(32);
  });

  test("keeps observed checks visible when inference does not fit", () => {
    expect(renderProgress({
      runStarted: true,
      agentActive: false,
      tools: [],
      checks: [{ id: "1", label: "bun test", outcome: "failed" }],
      touchedPaths: [],
      semantic: {
        phase: "Verification",
        current: "Waiting for a follow-up",
        completed: ["A very long inferred completion that should be dropped before observed facts"],
        blocked: [],
        confidence: 0.9,
      },
    }, theme, 45)).toEqual([
      "progress · ✓ settled · ✗ bun test",
    ]);
  });

  test("bounds long tool calls so the latest check remains visible", () => {
    const lines = renderProgress(
      {
        runStarted: true,
        agentActive: true,
        tools: [{ id: "1", name: "bash", label: `git status ${"x".repeat(100)}` }],
        checks: [
          { id: "2", label: "bun run check", outcome: "passed" },
          { id: "3", label: "go test ./cmd/uhh/...", outcome: "failed" },
        ],
        touchedPaths: [],
      },
      theme,
      80,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("● git status");
    expect(lines[0]).toContain("…");
    expect(lines[0]).toContain("✗ go test ./cmd/uhh/...");
    expect(lines[0]).not.toContain("bun run check");
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(80);
  });

  test("truncates rather than wrapping into additional rows", () => {
    const lines = renderProgress(
      {
        runStarted: true,
        agentActive: true,
        tools: [{ id: "1", name: "bash", label: `bash ${"x".repeat(100)}` }],
        checks: [],
        touchedPaths: ["a/very/long/path/that/would/wrap.ts"],
      },
      theme,
      30,
    );

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBeTrue();
  });
});
