import { describe, expect, test } from "bun:test";
import { ActivityDigest, redactSecrets, serializeDigest } from "../../extensions/progress/digest.ts";

describe("progress activity digest", () => {
  test("collects bounded metadata without tool output or edit contents", () => {
    let now = 100;
    const digest = new ActivityDigest(() => now);
    digest.begin(`Update auth with token=super-secret-value`);
    digest.startTool("edit", "edit", { path: "/repo/src/auth.ts", oldText: "private file bytes" }, "/repo");
    now = 125;
    digest.finishTool("edit", "edit", { path: "/repo/src/auth.ts", newText: "replacement file bytes" }, "/repo", false);
    digest.startTool("test", "bash", { command: "bun test --token=top-secret" }, "/repo");
    now = 150;
    digest.finishTool("test", "bash", { command: "bun test --token=top-secret" }, "/repo", false);
    digest.startTool("shell", "bash", { command: "cat > /tmp/x <<'EOF'\nraw inline file bytes\nEOF" }, "/repo");
    digest.finishTool("shell", "bash", { command: "cat > /tmp/x <<'EOF'\nraw inline file bytes\nEOF" }, "/repo", false);

    const snapshot = digest.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.events[0]).toEqual({
      tool: "edit",
      args: "path=src/auth.ts",
      outcome: "succeeded",
      durationMs: 25,
    });
    expect(serialized).not.toContain("private file bytes");
    expect(serialized).not.toContain("replacement file bytes");
    expect(serialized).not.toContain("raw inline file bytes");
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("super-secret-value");
    expect(snapshot.touchedPaths).toEqual(["src/auth.ts"]);
    expect(snapshot.checks).toEqual([{ command: "bun test --token=[REDACTED]", outcome: "passed" }]);
    expect(digest.meaningful()).toBeTrue();
  });

  test("filters read-only activity unless there is a user-visible outcome", () => {
    const digest = new ActivityDigest();
    digest.begin("Inspect code");
    digest.startTool("read", "read", { path: "/repo/a.ts" }, "/repo");
    digest.finishTool("read", "read", { path: "/repo/a.ts" }, "/repo", false);
    expect(digest.meaningful()).toBeFalse();
    digest.setFinalAssistant("Found the issue");
    expect(digest.meaningful()).toBeTrue();
  });

  test("redacts common credentials and caps serialized input", () => {
    expect(redactSecrets('Bearer abcdefghijkl token=my-secret AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI {"password":"quoted-secret"} ghp_abcdefghijklmnop')).toBe(
      'Bearer [REDACTED] token=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] {"password":"[REDACTED]"} [REDACTED]',
    );
    expect(serializeDigest({
      request: "safe",
      previous: { phase: "Work", current: "token=previous-secret", completed: [], blocked: [], confidence: 0.9 },
      events: [],
      touchedPaths: [],
      checks: [],
    }, 1_000)).not.toContain("previous-secret");
    const output = serializeDigest({ request: "x".repeat(200), events: [], touchedPaths: [], checks: [] }, 80);
    expect(output.length).toBeLessThanOrEqual(80);
  });
});
