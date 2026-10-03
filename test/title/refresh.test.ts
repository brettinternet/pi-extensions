import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import titleExtension from "../../extensions/title/index.js";
import {
  countCompletedExchanges,
  recentTranscript,
  RECENT_TRANSCRIPT_DEFAULTS,
} from "../../extensions/title/title.js";

const sessionModel = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };

let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

type Response = {
  content: Array<{ type: string; text?: string }>;
  stopReason: string;
};

function ok(text: string): () => Promise<Response> {
  return async () => ({ content: [{ type: "text", text }], stopReason: "stop" });
}

function slow() {
  const pending: { release?: () => void } = {};
  const response = () =>
    new Promise<Response>((resolve) => {
      pending.release = () => resolve({ content: [{ type: "text", text: "Refreshed title" }], stopReason: "stop" });
    });
  return { pending, response };
}

function configDir(config?: Record<string, unknown>): string {
  const dir = join("/tmp", `pi-title-refresh-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return writeConfig(dir, config);
}

function writeConfig(dir: string, config?: Record<string, unknown>): string {
  const path = join(dir, "pi-title.jsonc");
  writeFileSync(path, config ? JSON.stringify(config) : "{}", "utf8");
  return dir;
}

type BranchEntry = { type: string; message?: { role: string; content: unknown } };

function requestText(request: unknown): string {
  const messages = (request as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? [];
  return messages.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n");
}

interface HarnessOptions {
  dir: string;
  /** A name the session already had when it started. */
  name?: string;
  responses?: Array<() => Promise<Response>>;
}

function harness(options: HarnessOptions) {
  process.env.PI_CODING_AGENT_DIR = options.dir;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const requests: string[] = [];
  const titles: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const responses = [...(options.responses ?? [])];
  const branch: BranchEntry[] = [];
  let name = options.name;
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;

  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      command = options;
    },
    getSessionName: () => name,
    setSessionName: (title: string) => {
      name = title;
      titles.push(title);
      // The host reports every name change, including this extension's own write.
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: title }, ctx);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    model: sessionModel,
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, request: unknown) => {
        requests.push(requestText(request));
        const next = responses.shift();
        if (!next) throw new Error("no queued response");
        return { result: next };
      },
    },
    sessionManager: { getBranch: () => [...branch] },
    ui: {
      notify: (message: string, level = "info") => {
        notifications.push({ message, level });
      },
      setTitle: () => {},
    },
  } as unknown as ExtensionCommandContext;

  titleExtension(pi);

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  const waitForRequests = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (requests.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${requests.length} request(s), expected ${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await flush();
  };

  return {
    requests,
    titles,
    notifications,
    branch,
    start: () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
    /** A user message plus the request event that follows it. */
    prompt: (text: string) => {
      branch.push({ type: "message", message: { role: "user", content: text } });
      handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: text }, ctx);
    },
    /** A later user message, without the request event. */
    turn: (text: string) => {
      branch.push({ type: "message", message: { role: "user", content: text } });
    },
    /** The assistant reply that ends a turn, then the settle event for that turn. */
    reply: async (content: unknown) => {
      branch.push({ type: "message", message: { role: "assistant", content } });
      handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
      await flush();
    },
    renameExternally: (title: string) => {
      name = title;
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: title }, ctx);
    },
    /** Keep only the first `length` branch entries, then report the navigation. */
    navigateTree: (length: number) => {
      branch.length = length;
      handlers.get("session_tree")!({ type: "session_tree" }, ctx);
    },
    /** Start an explicit regeneration; returns once the handler settles. */
    regenerate: () => command!.handler("regenerate", ctx),
    flush,
    waitForRequests,
  };
}

describe("countCompletedExchanges", () => {
  const entries = (...messages: Array<[string, string]>): BranchEntry[] =>
    messages.map(([role, content]) => ({ type: "message", message: { role, content } }));

  test("counts only answered user turns", () => {
    expect(countCompletedExchanges([])).toBe(0);
    expect(countCompletedExchanges(entries(["user", "first"]))).toBe(0);
    expect(countCompletedExchanges(entries(["user", "first"], ["assistant", "done"]))).toBe(1);
    expect(
      countCompletedExchanges(
        entries(["user", "first"], ["assistant", "done"], ["user", "second"], ["assistant", "also done"]),
      ),
    ).toBe(2);
  });

  test("ignores an unanswered prompt and empty content", () => {
    expect(countCompletedExchanges(entries(["user", "first"], ["assistant", "done"], ["user", "next"]))).toBe(1);
    expect(countCompletedExchanges(entries(["user", "first"], ["assistant", ""]))).toBe(0);
    expect(countCompletedExchanges(entries(["user", ""], ["assistant", "done"]))).toBe(0);
  });

  test("counts several assistant messages of one turn once", () => {
    expect(
      countCompletedExchanges(
        entries(["user", "first"], ["assistant", "starting"], ["assistant", "finished"]),
      ),
    ).toBe(1);
  });
});

describe("recentTranscript", () => {
  const entries = (...messages: Array<[string, string]>): BranchEntry[] =>
    messages.map(([role, content]) => ({ type: "message", message: { role, content } }));

  test("renders the most recent messages oldest first", () => {
    expect(recentTranscript(entries(["user", "first"], ["assistant", "done"]))).toBe(
      "user: first\nassistant: done",
    );
  });

  test("keeps only the most recent messages and bounds each one", () => {
    const long = "x".repeat(RECENT_TRANSCRIPT_DEFAULTS.maxCharsPerMessage + 50);
    const many = Array.from({ length: 20 }, (_, index) => ["user", `message ${index}`] as [string, string]);
    const transcript = recentTranscript(entries(...many));

    expect(transcript).toContain("message 19");
    expect(transcript).not.toContain("message 11");
    expect(transcript!.split("\n")).toHaveLength(RECENT_TRANSCRIPT_DEFAULTS.maxMessages);

    // Each message is truncated to the per-message budget, plus its `role: ` prefix.
    const truncated = recentTranscript(entries(["user", long]))!;
    expect(truncated.length).toBeLessThanOrEqual(
      RECENT_TRANSCRIPT_DEFAULTS.maxCharsPerMessage + "user: ".length,
    );
    expect(truncated.length).toBeLessThan(long.length);
  });

  test("bounds the total length", () => {
    const chunk = "y".repeat(RECENT_TRANSCRIPT_DEFAULTS.maxCharsPerMessage);
    const many = Array.from({ length: 20 }, () => ["user", chunk] as [string, string]);
    expect(recentTranscript(entries(...many))!.length).toBeLessThanOrEqual(RECENT_TRANSCRIPT_DEFAULTS.maxChars);
  });

  test("keeps whole lines when the total budget is reached", () => {
    const chunk = "y".repeat(RECENT_TRANSCRIPT_DEFAULTS.maxCharsPerMessage);
    const many = Array.from({ length: 20 }, () => ["user", chunk] as [string, string]);
    const transcript = recentTranscript(entries(...many))!;

    expect(transcript.length).toBeLessThanOrEqual(RECENT_TRANSCRIPT_DEFAULTS.maxChars);
    // Every line arrives whole: the model must never be shown the tail of a word at the
    // start of the transcript.
    for (const line of transcript.split("\n")) {
      expect(line).toHaveLength(RECENT_TRANSCRIPT_DEFAULTS.maxCharsPerMessage + "user: ".length);
    }
    expect(transcript.startsWith("user: y")).toBe(true);
  });

  test("returns nothing without renderable messages", () => {
    expect(recentTranscript([])).toBeUndefined();
    expect(recentTranscript(entries(["assistant", "   "]))).toBeUndefined();
  });
});

describe("refreshing titles", () => {
  test("titles from the first request and refreshes every refreshTurns completed turns", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 4 }),
      responses: [ok("Initial title"), ok("Refreshed title"), ok("Second refresh")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);
    expect(h.titles).toEqual(["Initial title"]);

    // The opening exchange, then 3 more: still below the threshold of 4.
    for (let turn = 1; turn <= 4; turn += 1) {
      if (turn > 1) h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    expect(h.requests).toHaveLength(1);
    expect(h.titles).toEqual(["Initial title"]);

    h.turn("follow-up 5");
    await h.reply("answer 5");
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Initial title", "Refreshed title"]);
    // A refresh titles from recent context, not from the original request.
    expect(h.requests[1]).toContain("--- Recent session transcript ---");
    expect(h.requests[1]).toContain("user: follow-up 5");

    for (let turn = 6; turn <= 9; turn += 1) {
      h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    await h.waitForRequests(3);
    expect(h.titles).toEqual(["Initial title", "Refreshed title", "Second refresh"]);
  });

  test("zero refresh turns keeps the initial title and stops refreshing", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 0 }),
      responses: [ok("Initial title"), ok("Refreshed title")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    for (let turn = 1; turn <= 6; turn += 1) {
      h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    expect(h.titles).toEqual(["Initial title"]);
    expect(h.requests).toHaveLength(1);
  });

  test("disabling automatic titles after a title exists stops refreshing", async () => {
    const dir = configDir({ refreshTurns: 1 });
    const h = harness({ dir, responses: [ok("Initial title"), ok("Refreshed title")] });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);
    expect(h.titles).toEqual(["Initial title"]);

    writeConfig(dir, { enabled: false, refreshTurns: 1 });
    h.turn("follow-up");
    await h.reply("answer");
    await h.flush();
    expect(h.titles).toEqual(["Initial title"]);
    expect(h.requests).toHaveLength(1);
  });

  test("a title the user set is never replaced", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 1 }),
      responses: [ok("Initial title"), ok("Refreshed title")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    h.renameExternally("My own title");
    for (let turn = 1; turn <= 3; turn += 1) {
      h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    expect(h.titles).toEqual(["Initial title"]);
    expect(h.requests).toHaveLength(1);
  });

  test("a session that arrives named is left alone", async () => {
    const h = harness({ dir: configDir({ refreshTurns: 1 }), name: "Existing title", responses: [ok("New title")] });
    h.start();
    h.prompt("add retries to the upload API");
    await h.flush();

    expect(h.requests).toHaveLength(0);
    expect(h.titles).toEqual([]);
  });

  test("does not replace a name that changed while the refresh was in flight", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 1 }),
      responses: [
        ok("Initial title"),
        async () => {
          h.renameExternally("Renamed during the request");
          return { content: [{ type: "text", text: "Refreshed title" }], stopReason: "stop" };
        },
      ],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    // The opening exchange is the cadence anchor: with refreshTurns 1 the refresh starts
    // on the turn after it.
    h.turn("warm-up");
    await h.reply("warm-up answer");
    expect(h.requests).toHaveLength(1);

    h.turn("follow-up");
    await h.reply("answer");
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Initial title"]);
  });

  test("does not replace a name the user set away and back during the refresh", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 1 }),
      responses: [
        ok("Initial title"),
        async () => {
          // Renaming away and back leaves the current name equal to the title the
          // refresh captured, but the session is the user's now.
          h.renameExternally("User title");
          h.renameExternally("Initial title");
          return { content: [{ type: "text", text: "Refreshed title" }], stopReason: "stop" };
        },
      ],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    // One turn after the opening exchange, as above.
    h.turn("warm-up");
    await h.reply("warm-up answer");
    expect(h.requests).toHaveLength(1);

    h.turn("follow-up");
    await h.reply("answer");
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Initial title"]);
  });

  test("rebases the cadence on the active branch after tree navigation", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 4 }),
      responses: [ok("Initial title"), ok("Refreshed title"), ok("After the tree")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    // The opening exchange plus four follow-ups: one refresh, at the 5th turn.
    for (let turn = 1; turn <= 5; turn += 1) {
      if (turn > 1) h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    await h.waitForRequests(2);
    expect(h.titles).toHaveLength(2);

    // Back to the opening exchange, which counts as one completed turn.
    h.navigateTree(2);

    // Three more completed turns reach 4, which is below 1 + refreshTurns. Rebasing to
    // zero instead of the branch's real count would refresh here.
    for (let turn = 1; turn <= 3; turn += 1) {
      h.turn(`branch ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    expect(h.requests).toHaveLength(2);

    h.turn("branch 4");
    await h.reply("answer 4");
    await h.waitForRequests(3);
    expect(h.titles).toHaveLength(3);
  });

  test("names an unnamed session after tree navigation cancels its initial request", async () => {
    const { pending, response } = slow();
    const h = harness({
      dir: configDir({ refreshTurns: 4 }),
      responses: [response, ok("Named after the tree")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    h.turn("follow-up");
    await h.reply("answer");

    // Navigating cancels the slow opening request; the active branch still has an
    // exchange, so the session must end up named rather than left unnamed.
    h.navigateTree(3);
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Named after the tree"]);
    pending.release!();
  });

  test("does not consume a cadence slot while a refresh is still running", async () => {
    const { pending, response } = slow();
    const h = harness({
      dir: configDir({ refreshTurns: 4 }),
      responses: [ok("Initial title"), response, ok("Later refresh")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    for (let turn = 1; turn <= 5; turn += 1) {
      h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Initial title"]);

    // The threshold comes around again while the first refresh is still pending.
    for (let turn = 6; turn <= 9; turn += 1) {
      h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    expect(h.requests).toHaveLength(2);

    pending.release!();
    await h.flush();
    expect(h.titles).toEqual(["Initial title", "Refreshed title"]);

    // The slot was not consumed, so the next turn refreshes again.
    h.turn("follow-up 10");
    await h.reply("answer 10");
    await h.waitForRequests(3);
  });

  test("a turn with no assistant text does not advance the cadence", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 2 }),
      responses: [ok("Initial title"), ok("Refreshed title")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    h.turn("tool-only turn");
    await h.reply([{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }]);
    h.turn("another tool-only turn");
    await h.reply([{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]);
    expect(h.requests).toHaveLength(1);

    h.turn("real turn");
    await h.reply("answer");
    h.turn("another real turn");
    await h.reply("answer");
    expect(h.requests).toHaveLength(1);

    h.turn("a third real turn");
    await h.reply("answer");
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Initial title", "Refreshed title"]);
  });

  test("a pending regeneration does not consume a cadence slot", async () => {
    const { pending, response } = slow();
    const h = harness({
      dir: configDir({ refreshTurns: 4 }),
      responses: [ok("Initial title"), response, ok("Refreshed title")],
    });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    // Give the branch a completed exchange so regeneration has something to title.
    h.turn("warm-up");
    await h.reply("answer");

    // An explicit regeneration is in flight while the turn settles.
    const regeneration = h.regenerate();
    await h.waitForRequests(2);

    for (let turn = 2; turn <= 5; turn += 1) {
      h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    // The threshold passed while nothing could start, so the slot must be kept.
    expect(h.requests).toHaveLength(2);

    pending.release!();
    await regeneration;
    expect(h.titles).toEqual(["Initial title", "Refreshed title"]);

    h.turn("follow-up 6");
    await h.reply("answer 6");
    await h.waitForRequests(3);
  });

  test("reports a malformed configuration instead of rejecting in the background", async () => {
    const dir = configDir({ refreshTurns: 1 });
    const h = harness({ dir, responses: [ok("Initial title"), ok("Refreshed title")] });
    h.start();
    h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    writeFileSync(join(dir, "pi-title.jsonc"), "{ this is not json", "utf8");
    h.turn("follow-up");
    await h.reply("answer");
    await h.flush();

    expect(h.titles).toEqual(["Initial title"]);
    expect(h.notifications.some((notification) => notification.level === "error")).toBe(true);
  });
});
