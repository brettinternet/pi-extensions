import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withHerdrBlocked } from "../../extensions/shared/herdr-blocked.ts";

function harness() {
  const reports: unknown[] = [];
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        if (name === "herdr:blocked") reports.push(value);
      },
    },
  } as unknown as Pick<ExtensionAPI, "events">;
  return { pi, reports };
}

describe("Herdr blocked status", () => {
  test("reports blocked until approval succeeds", async () => {
    const { pi, reports } = harness();

    await expect(withHerdrBlocked(pi, "Approval required", async () => "approved"))
      .resolves.toBe("approved");

    expect(reports).toEqual([
      { active: true, label: "Approval required" },
      { active: false },
    ]);
  });

  test("clears blocked status when approval fails", async () => {
    const { pi, reports } = harness();

    await expect(withHerdrBlocked(pi, "Approval required", async () => {
      throw new Error("denied");
    })).rejects.toThrow("denied");

    expect(reports).toEqual([
      { active: true, label: "Approval required" },
      { active: false },
    ]);
  });
});
