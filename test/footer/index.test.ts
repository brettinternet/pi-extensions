import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  collectUsage,
  execSucceeded,
  formatFooterCwd,
  parseGitState,
  renderFooter,
  sanitizeFooterText,
  sanitizeStyledFooterText,
} from "../../extensions/footer/index.ts";
import footerExtension from "../../extensions/footer/index.ts";

const theme = {
  fg: (color: string, text: string) => `\x1b[${color}m${text}\x1b[0m`,
} as unknown as ExtensionContext["ui"]["theme"];

describe("footer usage", () => {
  test("includes assistant, tool, compaction, and branch-summary usage", () => {
    const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({
      input,
      output,
      cacheRead,
      cacheWrite,
      cost: { total: cost },
    });
    expect(collectUsage([
      { type: "message", message: { role: "assistant", usage: usage(100, 20, 50, 10, 0.1) } },
      { type: "message", message: { role: "toolResult", usage: usage(5, 2, 0, 0, 0.01) } },
      { type: "message", message: { role: "user", usage: usage(999, 999) } },
      { type: "compaction", usage: usage(10, 3, 2, 1, 0.02) },
      { type: "branch_summary", usage: usage(4, 1, 0, 0, 0.01) },
    ])).toEqual({
      input: 119,
      output: 26,
      cacheRead: 52,
      cacheWrite: 11,
      cost: 0.14,
      latestCacheHitRate: 31.25,
    });
  });
});

describe("footer git state", () => {
  test("rejects timed-out Git commands even when they report code zero", () => {
    expect(execSucceeded({ code: 0, killed: true })).toBeFalse();
    expect(execSucceeded({ code: 0, killed: false })).toBeTrue();
    expect(execSucceeded({ code: 1, killed: false })).toBeFalse();
  });

  test("counts worktree state and diff lines", () => {
    expect(parseGitState(
      "M  staged.ts\n M changed.ts\nMM both.ts\n?? new.ts\n",
      "12\t3\tstaged.ts\n5\t1\tchanged.ts\n-\t-\tbinary.png\n",
      "abcdef123456",
      2,
    )).toEqual({
      available: true,
      head: "abcdef123456",
      added: 17,
      removed: 4,
      staged: 2,
      unstaged: 2,
      untracked: 1,
      sessionCommits: 2,
      historyChanged: false,
    });
  });
});

describe("footer lifecycle", () => {
  test("reloads the commit baseline after session-tree navigation", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ranges: string[] = [];
    let branchEntries: unknown[] = [
      { type: "custom", customType: "pi-footer-git-baseline-v1", data: { cwd: "/repo", head: "base-a" } },
    ];
    let footerFactory: ((...args: any[]) => any) | undefined;
    const result = (stdout: string, code = 0) => ({ stdout, stderr: "", code, killed: false });
    const pi = {
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      appendEntry: () => {},
      getSessionName: () => undefined,
      exec: async (_command: string, args: string[]) => {
        const operation = args[2];
        if (operation === "rev-parse") return result("current\n");
        if (operation === "status" || operation === "diff") return result("");
        if (operation === "rev-list") {
          ranges.push(args.at(-1)!);
          return result("1\n");
        }
        return result("", 1);
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/repo",
      mode: "tui",
      sessionManager: {
        getBranch: () => branchEntries,
        getEntries: () => [],
      },
      getContextUsage: () => undefined,
      ui: { setFooter: (factory: typeof footerFactory) => { footerFactory = factory; } },
    } as unknown as ExtensionContext;

    footerExtension(pi);
    handlers.get("session_start")!({}, ctx);
    const component = footerFactory!(
      { requestRender: () => {} },
      theme,
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => () => {},
      },
    );
    await Bun.sleep(5);
    expect(ranges).toContain("base-a..current");

    branchEntries = [
      { type: "custom", customType: "pi-footer-git-baseline-v1", data: { cwd: "/repo", head: "base-b" } },
    ];
    handlers.get("session_tree")!({}, ctx);
    await Bun.sleep(5);
    expect(ranges).toContain("base-b..current");

    component.dispose();
  });
});

describe("footer rendering", () => {
  const snapshot = {
    cwd: "/Users/test/dev/project",
    home: "/Users/test",
    branch: "feature/footer",
    title: "Polish footer",
    model: { id: "gpt-5.4", provider: "openai", reasoning: true },
    thinkingLevel: "high",
    context: { tokens: 42_000, contextWindow: 114_000, percent: 36.8 },
    usage: {
      input: 86_000,
      output: 4_200,
      cacheRead: 61_000,
      cacheWrite: 2_000,
      cost: 0.124,
      latestCacheHitRate: 70.9,
    },
    git: {
      available: true,
      head: "abcdef123456",
      added: 18,
      removed: 4,
      staged: 2,
      unstaged: 1,
      untracked: 1,
      sessionCommits: 1,
    },
  };

  test("renders restrained Git icons, context, usage, and model details", () => {
    const lines = renderFooter(snapshot, 180, theme);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("~/dev/project");
    expect(lines[0]).toContain(" feature/footer");
    expect(lines[0]).toContain("+18");
    expect(lines[0]).toContain(" +1");
    expect(lines[0]).toContain("Polish footer");
    const plainUsageLine = lines[1]!.replace(/\x1b\[[0-9;A-Za-z]*m/g, "");
    expect(plainUsageLine).toContain("━━━━──────");
    expect(plainUsageLine).toContain("37%/114k");
    expect(plainUsageLine).not.toContain("42k");
    expect(plainUsageLine).toContain("↑86k ↓4.2k R61k");
    expect(plainUsageLine).toContain("$0.124");
    expect(plainUsageLine).toContain("openai/gpt-5.4");
    expect(plainUsageLine).toContain("high");
    expect(lines.join("\n")).not.toMatch(/[󰉋󰘦󰍉󰍌󰒍󰆼󰚩]/u);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(180);
    expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(180);
  });

  test("stays within narrow terminal widths", () => {
    for (const width of [30, 50, 80, 100]) {
      for (const line of renderFooter(snapshot, width, theme)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("strips terminal controls from external footer text", () => {
    const unsafe = "safe\x1b[2J\x1b]0;owned\x07\nnext";
    expect(sanitizeFooterText(unsafe)).toBe("safe[2J]0;owned next");
    expect(sanitizeStyledFooterText(`\x1b[38;5;6mLSP: 0/7\x1b[39m ${unsafe}`)).toBe(
      "\x1b[38;5;6mLSP: 0/7\x1b[39m safe[2J]0;owned next",
    );
    const lines = renderFooter({
      ...snapshot,
      branch: unsafe,
      title: unsafe,
      model: { ...snapshot.model, id: unsafe },
    }, 180, theme);
    expect(lines.join("\n")).not.toContain("\x1b[2J");
    expect(lines.join("\n")).not.toContain("\x1b]0;owned");
  });

  test("formats paths inside and outside home", () => {
    expect(formatFooterCwd("/Users/test/dev/project", "/Users/test")).toBe("~/dev/project");
    expect(formatFooterCwd("/opt/project", "/Users/test")).toBe("/opt/project");
  });
});
