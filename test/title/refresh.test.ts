import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import titleExtension from "../../extensions/title/index.js";
import * as titleConfig from "../../extensions/title/config.js";
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
  /** Session entries persisted before this run, such as a previous title record. */
  entries?: SessionEntry[];
}

type SessionEntry = { type: string; name?: string; customType?: string; data?: unknown };

function harness(options: HarnessOptions) {
  process.env.PI_CODING_AGENT_DIR = options.dir;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const requests: string[] = [];
  const events = new EventEmitter();
  const titles: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const responses = [...(options.responses ?? [])];
  const branch: BranchEntry[] = [];
  const entries: SessionEntry[] = [...(options.entries ?? [])];
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
      entries.push({ type: "session_info", name: title });
      // The host reports every name change, including this extension's own write.
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: title }, ctx);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
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
        events.emit("request");
        const next = responses.shift();
        if (!next) throw new Error("no queued response");
        return { result: next };
      },
    },
    sessionManager: { getBranch: () => [...branch], getEntries: () => [...entries] },
    ui: {
      notify: (message: string, level = "info") => {
        notifications.push({ message, level });
      },
      setTitle: () => {},
    },
  } as unknown as ExtensionCommandContext;

  titleExtension(pi);

  // Event handlers finish config I/O; one event-loop turn drains resolved model promises.
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const waitForRequests = async (count: number): Promise<void> => {
    while (requests.length < count) await once(events, "request");
    await flush();
  };

  return {
    requests,
    titles,
    notifications,
    branch,
    entries,
    start: () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
    /** A user message plus the request event that follows it. */
    prompt: async (text: string) => {
      branch.push({ type: "message", message: { role: "user", content: text } });
      await handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: text }, ctx);
      await flush();
    },
    /** A later user message, without the request event. */
    turn: (text: string) => {
      branch.push({ type: "message", message: { role: "user", content: text } });
    },
    /** The assistant reply that ends a turn, then the settle event for that turn. */
    reply: async (content: unknown) => {
      branch.push({ type: "message", message: { role: "assistant", content } });
      await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
      await flush();
    },
    renameExternally: (title: string) => {
      name = title;
      entries.push({ type: "session_info", name: title });
      handlers.get("session_info_changed")!({ type: "session_info_changed", name: title }, ctx);
    },
    /** Keep only the first `length` branch entries, then report the navigation. */
    navigateTree: async (length: number) => {
      branch.length = length;
      await handlers.get("session_tree")!({ type: "session_tree" }, ctx);
      await flush();
    },
    /** Start an explicit regeneration; returns once the handler settles. */
    regenerate: () => command!.handler("regenerate", ctx),
    rename: (title: string) => command!.handler(`set ${title}`, ctx),
    command: (args: string) => command!.handler(args, ctx),
    settle: () => handlers.get("agent_settled")!({ type: "agent_settled" }, ctx),
    shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
    await h.flush();

    expect(h.requests).toHaveLength(0);
    expect(h.titles).toEqual([]);
  });

  test("a resumed automatic title keeps refreshing from the resumed branch", async () => {
    const first = harness({ dir: configDir({ refreshTurns: 1 }), responses: [ok("Initial title")] });
    first.start();
    await first.prompt("add retries to the upload API");
    await first.waitForRequests(1);
    await first.reply("added retries");

    const resumed = harness({
      dir: configDir({ refreshTurns: 1 }),
      name: "Initial title",
      entries: first.entries,
      responses: [ok("Refreshed title")],
    });
    resumed.branch.push(...first.branch);
    resumed.start();
    await resumed.prompt("now add jitter");
    await resumed.reply("added jitter");
    await resumed.waitForRequests(1);

    expect(resumed.titles).toEqual(["Refreshed title"]);
  });

  test("a resumed title renamed after its automatic write is left alone", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 1 }),
      name: "Mine",
      entries: [
        { type: "session_info", name: "Mine" },
        { type: "custom", customType: "pi-title", data: { title: "Mine" } },
        { type: "session_info", name: "Other" },
        { type: "session_info", name: "Mine" },
      ],
      responses: [ok("New title")],
    });
    h.branch.push(
      { type: "message", message: { role: "user", content: "first" } },
      { type: "message", message: { role: "assistant", content: "done" } },
    );
    h.start();
    await h.prompt("next");
    await h.reply("done again");

    expect(h.requests).toHaveLength(0);
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    // The opening exchange plus four follow-ups: one refresh, at the 5th turn.
    for (let turn = 1; turn <= 5; turn += 1) {
      if (turn > 1) h.turn(`follow-up ${turn}`);
      await h.reply(`answer ${turn}`);
    }
    await h.waitForRequests(2);
    expect(h.titles).toHaveLength(2);

    // Back to the opening exchange, which counts as one completed turn.
    await h.navigateTree(2);

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
    await h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    h.turn("follow-up");
    await h.reply("answer");

    // Navigating cancels the slow opening request; the active branch still has an
    // exchange, so the session must end up named rather than left unnamed.
    await h.navigateTree(3);
    await h.waitForRequests(2);
    expect(h.titles).toEqual(["Named after the tree"]);
    pending.release!();
    await h.flush();
    expect(h.titles).toEqual(["Named after the tree"]);
  });

  test("does not consume a cadence slot while a refresh is still running", async () => {
    const { pending, response } = slow();
    const h = harness({
      dir: configDir({ refreshTurns: 4 }),
      responses: [ok("Initial title"), response, ok("Later refresh")],
    });
    h.start();
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
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
    await h.prompt("add retries to the upload API");
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

  test("loads one configuration snapshot per initial or refresh evaluation", async () => {
    const config = { ...titleConfig.DEFAULT_CONFIG, refreshTurns: 1 };
    const load = spyOn(titleConfig, "loadConfig").mockResolvedValue(config);
    try {
      const h = harness({ dir: configDir(), responses: [ok("Initial title"), ok("Refreshed title")] });
      h.start();
      await h.prompt("first request");
      expect(load).toHaveBeenCalledTimes(1);
      expect(h.titles).toEqual(["Initial title"]);
      await h.reply("first answer");
      expect(load).toHaveBeenCalledTimes(2);
      h.turn("follow-up");
      await h.reply("second answer");
      expect(load).toHaveBeenCalledTimes(3);
      expect(h.titles).toEqual(["Initial title", "Refreshed title"]);
      h.shutdown();
    } finally {
      load.mockRestore();
    }
  });

  test("shutdown during configuration loading prevents a request", async () => {
    const config = Promise.withResolvers<titleConfig.Config>();
    const load = spyOn(titleConfig, "loadConfig").mockReturnValue(config.promise);
    try {
      const h = harness({ dir: configDir(), responses: [ok("Must not be written")] });
      h.start();
      const evaluation = h.prompt("first request");
      expect(load).toHaveBeenCalledTimes(1);
      h.shutdown();
      config.resolve(titleConfig.DEFAULT_CONFIG);
      await evaluation;
      expect(h.requests).toEqual([]);
      expect(h.titles).toEqual([]);
    } finally {
      load.mockRestore();
    }
  });

  test("shutdown cancels an in-flight refresh without writing its result", async () => {
    const { pending, response } = slow();
    const h = harness({ dir: configDir({ refreshTurns: 1 }), responses: [ok("Initial title"), response] });
    h.start();
    await h.prompt("first request");
    await h.reply("first answer");
    h.turn("follow-up");
    await h.reply("answer");
    await h.waitForRequests(2);
    h.shutdown();
    pending.release!();
    await h.flush();
    expect(h.titles).toEqual(["Initial title"]);
    expect(h.notifications).toEqual([]);
  });

  test("a failed refresh spends its slot but a duplicate settle does not start another", async () => {
    const h = harness({
      dir: configDir({ refreshTurns: 1 }),
      responses: [ok("Initial title"), async () => { throw new Error("provider unavailable"); }, ok("Recovered title")],
    });
    h.start();
    await h.prompt("first request");
    await h.reply("first answer");
    h.turn("follow-up");
    await h.reply("answer");
    expect(h.notifications).toEqual([{ message: "provider unavailable", level: "error" }]);
    await h.settle();
    expect(h.requests).toHaveLength(2);
    h.turn("another follow-up");
    await h.reply("answer");
    expect(h.titles).toEqual(["Initial title", "Recovered title"]);
  });

  test("explicit regeneration stays available when automatic titles are disabled", async () => {
    const h = harness({ dir: configDir({ enabled: false, refreshTurns: 1 }), responses: [ok("Explicit title")] });
    h.start();
    await h.prompt("first request");
    await h.reply("answer");
    expect(h.requests).toEqual([]);
    await h.regenerate();
    expect(h.titles).toEqual(["Explicit title"]);
    h.turn("follow-up");
    await h.reply("answer");
    expect(h.requests).toHaveLength(1);
  });

  test("regeneration titles a single exchange from the opening request and reply", async () => {
    const h = harness({ dir: configDir({ enabled: false }), responses: [ok("Explicit title")] });
    h.start();
    await h.prompt("first request");
    await h.reply("first answer");
    await h.regenerate();
    expect(h.requests[0]).toContain("--- First user request ---");
    expect(h.requests[0]).toContain("first answer");
  });

  test("regeneration titles a longer session from recent messages", async () => {
    const h = harness({ dir: configDir({ enabled: false }), responses: [ok("Explicit title")] });
    h.start();
    await h.prompt("first request");
    await h.reply("first answer");
    h.turn("latest request");
    await h.reply("latest answer");
    await h.regenerate();
    expect(h.requests[0]).toContain("--- Recent session transcript ---");
    expect(h.requests[0]).toContain("user: latest request");
    expect(h.requests[0]).toContain("assistant: latest answer");
  });

  test("/title every shows, saves, and validates the interval", async () => {
    const dir = configDir();
    const h = harness({ dir });
    await h.command("every");
    await h.command("every 4");
    expect((await titleConfig.loadConfig()).refreshTurns).toBe(4);
    await h.command("every off");
    expect((await titleConfig.loadConfig()).refreshTurns).toBe(0);
    await h.command("every -1");
    await h.command("every 2.5");
    expect((await titleConfig.loadConfig()).refreshTurns).toBe(0);
    expect(h.notifications).toEqual([
      { message: "Title refresh: off", level: "info" },
      { message: "Title refresh: every 4 answered turns", level: "info" },
      { message: "Title refresh: off", level: "info" },
      { message: "usage: /title every <turns|off>", level: "error" },
      { message: "usage: /title every <turns|off>", level: "error" },
    ]);
    expect(h.titles).toEqual([]);
  });

  test("regeneration does not unpin a session that arrived named", async () => {
    const h = harness({ dir: configDir({ refreshTurns: 1 }), name: "My title", responses: [ok("Explicit title")] });
    h.start();
    await h.prompt("first request");
    await h.reply("answer");
    await h.regenerate();
    h.turn("follow-up");
    await h.reply("answer");
    expect(h.requests).toHaveLength(1);
    expect(h.titles).toEqual(["Explicit title"]);
  });

  test("setting the current automatic title explicitly pins it too", async () => {
    const h = harness({ dir: configDir({ refreshTurns: 1 }), responses: [ok("Initial title"), ok("Explicit title")] });
    h.start();
    await h.prompt("first request");
    await h.reply("answer");
    await h.rename("Initial title");
    await h.regenerate();
    h.turn("follow-up");
    await h.reply("answer");
    expect(h.requests).toHaveLength(2);
    expect(h.titles).toEqual(["Initial title", "Initial title", "Explicit title"]);
  });

  test("reports a malformed configuration instead of rejecting in the background", async () => {
    const dir = configDir({ refreshTurns: 1 });
    const h = harness({ dir, responses: [ok("Initial title"), ok("Refreshed title")] });
    h.start();
    await h.prompt("add retries to the upload API");
    await h.waitForRequests(1);

    writeFileSync(join(dir, "pi-title.jsonc"), "{ this is not json", "utf8");
    h.turn("follow-up");
    await h.reply("answer");
    await h.flush();

    expect(h.titles).toEqual(["Initial title"]);
    expect(h.notifications.some((notification) => notification.level === "error")).toBe(true);
  });
});
