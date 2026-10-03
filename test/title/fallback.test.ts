import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import titleExtension, {
  classifyTitleFailure,
  resolveModelChain,
  titleRetryDelayMs,
} from "../../extensions/title/index.js";
import { DEFAULT_CONFIG } from "../../extensions/title/config.js";

type ModelContext = Parameters<typeof resolveModelChain>[0];
type Model = NonNullable<ModelContext["model"]>;

const sessionModel = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" } as unknown as Model;
const configuredModel = { provider: "anthropic", id: "claude-haiku-4-5" } as unknown as Model;

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
  errorMessage?: string;
};

function ok(text: string): () => Promise<Response> {
  return async () => ({ content: [{ type: "text", text }], stopReason: "stop" });
}

function providerError(message: string, status?: number): () => Promise<Response> {
  return async () => {
    throw Object.assign(new Error(message), status === undefined ? {} : { status });
  };
}

function failedResponse(message: string): () => Promise<Response> {
  return async () => ({ content: [], stopReason: "error", errorMessage: message });
}

function configDir(config?: Record<string, unknown>): string {
  const dir = join("/tmp", `pi-title-fallback-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  if (config) writeFileSync(join(dir, "pi-title.jsonc"), JSON.stringify(config), "utf8");
  return dir;
}

interface HarnessOptions {
  dir: string;
  models?: Model[];
  responses?: Array<() => Promise<Response>>;
  /** Mark the context stale once this many attempts have started. */
  staleAfterAttempts?: number;
  /** Make the terminal-title write fail, the way a broken terminal would. */
  setTitleThrows?: boolean;
}

const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload.";

function harness(options: HarnessOptions) {
  process.env.PI_CODING_AGENT_DIR = options.dir;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const attempts: string[] = [];
  const titles: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const responses = [...(options.responses ?? [])];
  const models = options.models ?? [];
  let stale = false;

  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
    },
    registerCommand: () => {},
    getSessionName: () => {
      if (stale) throw new Error(STALE_MESSAGE);
      return titles.at(-1);
    },
    setSessionName: (title: string) => {
      titles.push(title);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/tmp/project",
    get hasUI() {
      if (stale) throw new Error(STALE_MESSAGE);
      return true;
    },
    model: sessionModel,
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
      hasConfiguredAuth: () => true,
      streamSimple: (model: Model) => {
        attempts.push(`${model.provider}/${model.id}`);
        if (options.staleAfterAttempts !== undefined && attempts.length >= options.staleAfterAttempts) {
          stale = true;
        }
        const next = responses.shift();
        if (!next) throw new Error("no queued response");
        return { result: next };
      },
    },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "add retries to the upload API" } },
        { type: "message", message: { role: "assistant", content: "Done." } },
      ],
    },
    ui: {
      notify: (message: string, level = "info") => {
        notifications.push({ message, level });
      },
      setTitle: () => {
        if (options.setTitleThrows) throw new Error("terminal title write failed");
      },
    },
  } as unknown as ExtensionCommandContext;

  titleExtension(pi);

  const settle = async (graceMs: number): Promise<void> => {
    // Returns as soon as an outcome exists, because a produced title or a terminal error
    // ends the attempt. Callers asserting that *nothing* happened must pass a grace
    // longer than any pending backoff.
    const deadline = Date.now() + graceMs;
    while (titles.length === 0 && notifications.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const waitForAttempts = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (attempts.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${attempts.length} attempt(s), expected ${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const start = (): void => {
    handlers.get("before_agent_start")!(
      { type: "before_agent_start", prompt: "add retries to the upload API" },
      ctx,
    );
  };

  return {
    attempts,
    titles,
    notifications,
    start,
    waitForAttempts,
    /** Wait for the attempt to settle. `graceMs` must outlast any pending backoff. */
    settle,
    shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
  };
}

async function run(h: ReturnType<typeof harness>, expectAttempts = 1, graceMs = 700): Promise<void> {
  h.start();
  await h.waitForAttempts(expectAttempts);
  await h.settle(graceMs);
}

describe("classifyTitleFailure", () => {
  test("classifies deterministic HTTP failures as non-retryable", () => {
    expect(classifyTitleFailure(Object.assign(new Error("nope"), { status: 402 }))).toMatchObject({
      kind: "billing",
      status: 402,
      retryable: false,
    });
    expect(classifyTitleFailure(Object.assign(new Error("nope"), { status: 401 }))).toMatchObject({
      kind: "auth",
      retryable: false,
    });
    expect(classifyTitleFailure(Object.assign(new Error("nope"), { status: 404 }))).toMatchObject({
      kind: "not-found",
      retryable: false,
    });
    expect(classifyTitleFailure(Object.assign(new Error("nope"), { status: 400 }))).toMatchObject({
      kind: "invalid",
      retryable: false,
    });
  });

  test("classifies transient HTTP failures as retryable", () => {
    expect(classifyTitleFailure(Object.assign(new Error("nope"), { status: 429 }))).toMatchObject({
      kind: "rate-limit",
      status: 429,
      retryable: true,
    });
    for (const status of [500, 502, 503, 504, 520, 524]) {
      expect(classifyTitleFailure(Object.assign(new Error("nope"), { status }))).toMatchObject({
        kind: "server",
        retryable: true,
      });
    }
  });

  test("keeps quota exhaustion deterministic even when it reports 429", () => {
    // Pi's own classifier treats account/billing limits as non-retryable, and a
    // throttle status must not turn a deterministic failure into a retry.
    for (const message of [
      "429 insufficient_quota",
      "429 Monthly usage limit reached",
      "429 quota exceeded",
      "429 subscription_sharing_usage_limit_exceeded",
      "HTTP 402 payment required: insufficient credits",
    ]) {
      expect(classifyTitleFailure(Object.assign(new Error(message), { status: 429 }))).toMatchObject({
        kind: "billing",
        retryable: false,
      });
    }
  });

  test("retries temporary subscription unavailability but not an exhausted limit", () => {
    // The label depends on whether the message states a status; what matters is that
    // temporary unavailability is retried while an exhausted limit is not.
    for (const message of [
      "429 subscription_sharing_usage_unavailable",
      "429 subscription_sharing_user_unavailable",
    ]) {
      expect(classifyTitleFailure(new Error(message))).toMatchObject({ retryable: true });
    }
    expect(classifyTitleFailure(new Error("429 subscription_sharing_usage_limit_exceeded"))).toMatchObject({
      kind: "billing",
      retryable: false,
    });
  });

  test("honours a structured status over conflicting wording", () => {
    // An authoritative provider status must not be overridden by incidental text.
    expect(classifyTitleFailure(Object.assign(new Error("fetch failed"), { status: 401 }))).toMatchObject({
      kind: "auth",
      retryable: false,
    });
    expect(
      classifyTitleFailure(Object.assign(new Error("malformed upstream response"), { status: 503 })),
    ).toMatchObject({ kind: "server", retryable: true });
  });

  test("reads a stated status through the prefix the title call adds", () => {
    // A completion failure is wrapped to add context. The status is only a status while it
    // still leads the message, so classification has to look past the wrapper: otherwise
    // "Provider returned error" wording wins and a deterministic 400 is retried.
    expect(classifyTitleFailure(new Error("title model failed: 400: Provider returned error"))).toMatchObject({
      kind: "invalid",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("title model failed: 503: unavailable"))).toMatchObject({
      kind: "server",
      retryable: true,
    });
  });

  test("does not retry a wrapped 400 that arrives as a completion error", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/missing" }),
      models: [sessionModel],
      responses: [failedResponse("400: Provider returned error")],
    });
    await run(h, 1);
    // One attempt: the stated status decides, not the wording that follows it.
    expect(h.attempts).toEqual(["openrouter/deepseek/deepseek-v4.1-flash"]);
    expect(h.titles).toEqual([]);
    expect(h.notifications).toEqual([
      { message: "title model failed: 400: Provider returned error", level: "error" },
    ]);
  });

  test("honours a stated status over conflicting wording", () => {
    // "Provider returned error" wording must not turn an explicit 400 into a retry.
    expect(classifyTitleFailure(new Error("400: Provider returned error"))).toMatchObject({
      kind: "invalid",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("HTTP 400: failure for model-500"))).toMatchObject({
      kind: "invalid",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("409 Conflict"))).toMatchObject({ kind: "rate-limit", retryable: true });
    expect(classifyTitleFailure(new Error("501 Not Implemented"))).toMatchObject({ kind: "server", retryable: true });
  });

  test("treats premature stream endings as retryable transport failures", () => {
    for (const message of [
      "Anthropic stream ended before message_stop",
      "Stream ended without finish_reason",
      "http2 request did not get a response",
    ]) {
      expect(classifyTitleFailure(new Error(message))).toMatchObject({
        kind: "network",
        retryable: true,
      });
    }
  });

  test("classifies failures that only carry provider text", () => {
    expect(classifyTitleFailure(new Error("402 payment required: insufficient credits"))).toMatchObject({
      kind: "billing",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("upstream returned 429 too many requests"))).toMatchObject({
      kind: "rate-limit",
      retryable: true,
    });
    expect(classifyTitleFailure(new Error("model does not exist on this provider"))).toMatchObject({
      kind: "not-found",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("fetch failed: socket hang up"))).toMatchObject({
      kind: "network",
      retryable: true,
    });
  });

  test("recognises transport errno codes", () => {
    for (const message of ["read ECONNRESET", "connect ECONNREFUSED", "write EPIPE"]) {
      expect(classifyTitleFailure(new Error(message))).toMatchObject({ kind: "network", retryable: true });
    }
  });

  test("reads limit information from structured error codes", () => {
    expect(
      classifyTitleFailure(Object.assign(new Error("request failed"), { status: 429, code: "insufficient_quota" })),
    ).toMatchObject({ kind: "billing", retryable: false });
    expect(
      classifyTitleFailure(
        Object.assign(new Error("request failed"), {
          status: 429,
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        }),
      ),
    ).toMatchObject({ kind: "billing", retryable: false });
    // A retryable code in the same position must stay retryable.
    expect(
      classifyTitleFailure(Object.assign(new Error("request failed"), { status: 429, code: "overloaded" })),
    ).toMatchObject({ retryable: true });
  });

  test("only treats a number as a status where the message presents one", () => {
    // Real provider text: the value after the colon is a URL, not a status.
    expect(classifyTitleFailure(new Error("Invalid Azure OpenAI base URL: 500"))).toMatchObject({
      kind: "invalid",
      retryable: false,
    });
    // A leading status settles a message that mentions several statuses.
    expect(
      classifyTitleFailure(new Error("400: Provider returned error; upstream status 503")),
    ).toMatchObject({ kind: "invalid", retryable: false });
    expect(classifyTitleFailure(new Error("(429) Too Many Requests"))).toMatchObject({
      kind: "rate-limit",
      retryable: true,
    });
  });

  test("does not read a status number out of unrelated text", () => {
    // A number that is not presented as a status must not decide the retry: the
    // transport failure below is retried, the unrelated 500 is not promoted.
    expect(classifyTitleFailure(new Error("model-400: fetch failed"))).toMatchObject({
      kind: "network",
      retryable: true,
    });
    expect(classifyTitleFailure(new Error("model-500: request rejected"))).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
  });

  test("only explicit abort wording is terminal", () => {
    expect(classifyTitleFailure(new Error("The operation was aborted"))).toMatchObject({
      kind: "aborted",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("AbortError: request cancelled"))).toMatchObject({
      kind: "aborted",
      retryable: false,
    });
    // A model named after "cancelled" or "aborted" must still fall back rather than abort.
    expect(classifyTitleFailure(new Error("404: model 'cancelled-small' not found"))).toMatchObject({
      kind: "not-found",
      retryable: false,
    });
    expect(classifyTitleFailure(new Error("404: model 'aborted-small' not found"))).toMatchObject({
      kind: "not-found",
      retryable: false,
    });
  });

  test("classifies an empty completion as retryable", () => {
    expect(
      classifyTitleFailure(new Error("title model returned no usable text (stop reason: length)")),
    ).toMatchObject({ kind: "empty", retryable: true });
    expect(classifyTitleFailure(new Error("something else entirely"))).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
  });
});

describe("titleRetryDelayMs", () => {
  test("backs off exponentially and caps the delay", () => {
    expect([1, 2, 3, 4, 5].map(titleRetryDelayMs)).toEqual([500, 1_000, 2_000, 4_000, 4_000]);
  });
});

describe("resolveModelChain", () => {
  const context = (models: Model[] = [configuredModel]) => ({
    model: sessionModel,
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
      hasConfiguredAuth: () => true,
    },
  }) as unknown as ModelContext;

  test("uses the active session model alone when nothing is configured", () => {
    const chain = resolveModelChain(context([]), { ...DEFAULT_CONFIG, model: null });
    expect(chain.candidates).toEqual([{ model: sessionModel, thinkingLevel: undefined, source: "configured" }]);
    expect(chain.configuredFailure).toBeUndefined();
  });

  test("appends the session model as a fallback for a configured model", () => {
    const chain = resolveModelChain(context(), { ...DEFAULT_CONFIG, model: "anthropic/claude-haiku-4-5" });
    expect(chain.candidates.map((candidate) => [candidate.source, candidate.model.id])).toEqual([
      ["configured", "claude-haiku-4-5"],
      ["session", "deepseek/deepseek-v4.1-flash"],
    ]);
  });

  test("does not duplicate the session model when it is also the configured model", () => {
    const chain = resolveModelChain(context([sessionModel]), {
      ...DEFAULT_CONFIG,
      model: "openrouter/deepseek/deepseek-v4.1-flash",
    });
    expect(chain.candidates).toHaveLength(1);
    expect(chain.candidates[0]!.source).toBe("configured");
  });

  test("records an unresolvable configured model instead of throwing", () => {
    const chain = resolveModelChain(context([]), { ...DEFAULT_CONFIG, model: "anthropic/missing" });
    expect(chain.configuredFailure).toBe("configured model is unavailable: anthropic/missing");
    expect(chain.candidates).toEqual([{ model: sessionModel, thinkingLevel: undefined, source: "session" }]);
  });
});

describe("model fallback", () => {
  test("uses the configured model when it works and stays silent", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [ok("Add upload API retries")],
    });
    await run(h);
    expect(h.attempts).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([]);
  });

  test("falls back to the session model when the configured model is unavailable", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/missing" }),
      models: [sessionModel, configuredModel],
      responses: [ok("Add upload API retries")],
    });
    await run(h);
    expect(h.attempts).toEqual(["openrouter/deepseek/deepseek-v4.1-flash"]);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([
      {
        message: "Configured title model anthropic/missing is unavailable; used openrouter/deepseek/deepseek-v4.1-flash",
        level: "warning",
      },
    ]);
  });

  test("falls back to the session model when the configured model is rate limited", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [providerError("rate limited", 429), ok("Add upload API retries")],
    });
    await run(h, 2);
    expect(h.attempts).toEqual(["anthropic/claude-haiku-4-5", "openrouter/deepseek/deepseek-v4.1-flash"]);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([
      {
        message: "Configured title model anthropic/claude-haiku-4-5 failed (rate limited); used openrouter/deepseek/deepseek-v4.1-flash",
        level: "warning",
      },
    ]);
  });

  test("falls back when the failure only appears in the completion text", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [
        failedResponse("Anthropic stream ended before message_stop"),
        ok("Add upload API retries"),
      ],
    });
    await run(h, 2);
    expect(h.attempts).toEqual(["anthropic/claude-haiku-4-5", "openrouter/deepseek/deepseek-v4.1-flash"]);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.message).toBe(
      "Configured title model anthropic/claude-haiku-4-5 failed (network error); used openrouter/deepseek/deepseek-v4.1-flash",
    );
  });

  test("moves on immediately for a deterministic billing failure", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [providerError("insufficient credits", 402), ok("Add upload API retries")],
    });
    await run(h, 2);
    // Exactly one attempt on the configured model: no bounded retry for a deterministic failure.
    expect(h.attempts).toEqual(["anthropic/claude-haiku-4-5", "openrouter/deepseek/deepseek-v4.1-flash"]);
    expect(h.notifications[0]?.message).toContain("failed (insufficient credits)");
  });

  test("does not retry a quota failure reported as 429 on the only candidate", async () => {
    for (const message of ["429 insufficient_quota", "429 subscription_sharing_usage_limit_exceeded"]) {
      const h = harness({
        dir: configDir(),
        models: [sessionModel],
        responses: [providerError(message)],
      });
      await run(h);
      // The only candidate gets one attempt: a billing limit is not a transient throttle.
      expect(h.attempts).toEqual(["openrouter/deepseek/deepseek-v4.1-flash"]);
      expect(h.titles).toEqual([]);
      expect(h.notifications).toEqual([{ message, level: "error" }]);
    }
  });

  test("retries once on a transient failure when there is no fallback model", async () => {
    const h = harness({
      dir: configDir(),
      models: [sessionModel],
      responses: [providerError("service unavailable", 503), ok("Add upload API retries")],
    });
    await run(h, 2);
    expect(h.attempts).toEqual([
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/deepseek/deepseek-v4.1-flash",
    ]);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([]);
  });

  test("retries a premature stream ending on the only candidate", async () => {
    const h = harness({
      dir: configDir(),
      models: [sessionModel],
      responses: [providerError("Anthropic stream ended before message_stop"), ok("Add upload API retries")],
    });
    await run(h, 2);
    expect(h.attempts).toHaveLength(2);
    expect(h.titles).toEqual(["Add upload API retries"]);
  });

  test("explains the replaced model, not a later failure of the fallback", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [
        providerError("insufficient credits", 402),
        providerError("service unavailable", 503),
        ok("Add upload API retries"),
      ],
    });
    await run(h, 3);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([
      {
        message: "Configured title model anthropic/claude-haiku-4-5 failed (insufficient credits); used openrouter/deepseek/deepseek-v4.1-flash",
        level: "warning",
      },
    ]);
  });

  test("reports an unavailable configured model when the fallback itself recovers", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/missing" }),
      models: [sessionModel, configuredModel],
      responses: [providerError("service unavailable", 503), ok("Add upload API retries")],
    });
    await run(h, 2);
    expect(h.attempts).toEqual([
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/deepseek/deepseek-v4.1-flash",
    ]);
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([
      {
        message: "Configured title model anthropic/missing is unavailable; used openrouter/deepseek/deepseek-v4.1-flash",
        level: "warning",
      },
    ]);
  });

  test("does not count a request abort as a failure to fall back from", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [providerError("The operation was aborted"), ok("Add upload API retries")],
    });
    await run(h, 1);
    expect(h.attempts).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(h.titles).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  test("stops silently when the session shuts down during backoff", async () => {
    const h = harness({
      dir: configDir(),
      models: [sessionModel],
      responses: [providerError("service unavailable", 503), ok("Add upload API retries")],
    });
    h.start();
    await h.waitForAttempts(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    h.shutdown();
    await h.settle(700);
    // Shutdown aborts the controller mid-backoff. This asserts the observable outcome
    // (no further attempt, no title, no warning). It does not separate the sleep's abort
    // listener from the loop's post-sleep lifecycle check, because either one produces
    // the same externally visible result.
    expect(h.attempts).toHaveLength(1);
    expect(h.titles).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  test("writes the title and still reports the fallback when the terminal title cannot be set", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/missing" }),
      models: [sessionModel, configuredModel],
      responses: [ok("Add upload API retries")],
      setTitleThrows: true,
    });
    await run(h, 1);
    // The terminal title is cosmetic: losing it must not report a failure for a title that
    // was written, nor swallow the fallback report that follows it in the same path.
    expect(h.titles).toEqual(["Add upload API retries"]);
    expect(h.notifications).toEqual([
      {
        message: "Configured title model anthropic/missing is unavailable; used openrouter/deepseek/deepseek-v4.1-flash",
        level: "warning",
      },
    ]);
  });

  test("propagates a stale context unchanged instead of falling back", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [ok("Add upload API retries"), ok("Session title")],
      staleAfterAttempts: 1,
    });
    await run(h, 1);
    // The replacement event owns stale-context suppression; aggregating the error
    // would hide it and make the handler read an invalid context.
    expect(h.attempts).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(h.titles).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  test("preserves the original error when a single model fails once", async () => {
    const h = harness({
      dir: configDir(),
      models: [sessionModel],
      responses: [providerError("sentinel-boom-1234")],
    });
    await run(h, 1);
    expect(h.titles).toEqual([]);
    // An aggregated wrapper would read "title model failed: ..." instead. Error identity
    // is not observable through ctx.ui.notify, so this pins the observable contract.
    expect(h.notifications).toEqual([{ message: "sentinel-boom-1234", level: "error" }]);
  });

  test("reports every failed model when the whole chain is exhausted", async () => {
    const h = harness({
      dir: configDir({ model: "anthropic/claude-haiku-4-5" }),
      models: [sessionModel, configuredModel],
      responses: [
        providerError("insufficient credits", 402),
        providerError("service unavailable", 503),
        providerError("service unavailable", 503),
      ],
    });
    await run(h, 3);
    expect(h.attempts).toEqual([
      "anthropic/claude-haiku-4-5",
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/deepseek/deepseek-v4.1-flash",
    ]);
    expect(h.titles).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.level).toBe("error");
    expect(h.notifications[0]?.message).toStartWith("title model failed: ");
    expect(h.notifications[0]?.message).toContain("anthropic/claude-haiku-4-5 (insufficient credits)");
    expect(h.notifications[0]?.message).toContain("openrouter/deepseek/deepseek-v4.1-flash (provider server error)");
  });
});
