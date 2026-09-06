import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeArguments, completeModelArgument } from "./completions.ts";
import { configPath, loadConfig, saveConfig, type ProgressConfig } from "./config.ts";
import { ActivityDigest } from "./digest.ts";
import {
  completeInference,
  inferenceFromCompletion,
  inferenceRequest,
  isInferenceModelReference,
  parseInference,
  resolveInferenceModel,
} from "./inference.ts";
import { renderProgress } from "./render.ts";
import { ProgressState } from "./state.ts";

const WIDGET_KEY = "pi-progress";
const ACTIVE_INFERENCE_DEBOUNCE_MS = 500;
const MAX_ACTIVE_INFERENCES_PER_RUN = 4;
export const INFERENCE_ENTRY = "pi-progress-inference-v1";

type BranchEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const block = part as { type?: string; text?: string };
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
}

export default function progressExtension(pi: ExtensionAPI): void {
  const state = new ProgressState();
  const digest = new ActivityDigest();
  let currentContext: ExtensionContext | undefined;
  let renderScheduled = false;
  let activeInferenceTimer: ReturnType<typeof setTimeout> | undefined;
  let inferenceController: AbortController | undefined;
  let inferencePromise: Promise<void> | undefined;
  let lastInferenceError: string | undefined;
  let warned = false;
  let configuredModel: string | null = null;
  let activeInferenceCount = 0;

  function render(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx !== currentContext) return;
    const snapshot = state.snapshot();
    const hasFacts =
      snapshot.runStarted ||
      snapshot.agentActive ||
      snapshot.tools.length > 0 ||
      snapshot.checks.length > 0 ||
      snapshot.touchedPaths.length > 0 ||
      Boolean(snapshot.semantic);
    if (!hasFacts) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width) => renderProgress(snapshot, theme, width),
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );
  }

  function scheduleRender(ctx: ExtensionContext): void {
    if (currentContext && ctx !== currentContext) return;
    currentContext ??= ctx;
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      render(ctx);
    });
  }

  function cancelInference(): void {
    if (activeInferenceTimer !== undefined) clearTimeout(activeInferenceTimer);
    activeInferenceTimer = undefined;
    inferenceController?.abort();
    inferenceController = undefined;
    inferencePromise = undefined;
  }

  function noteActivity(ctx: ExtensionContext): void {
    cancelInference();
    state.invalidateInference();
    state.setSemantic(undefined);
    scheduleRender(ctx);
  }

  function reportInferenceError(ctx: ExtensionContext, error: unknown): void {
    lastInferenceError = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 240);
    if (warned) return;
    warned = true;
    const message = `Progress inference: ${lastInferenceError}`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(`[pi-progress] ${message}`);
  }

  function restoreSemantic(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager?.getBranch?.() as BranchEntry[] | undefined;
    if (!branch) return;
    let latestUserIndex = -1;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (latestUserIndex < 0 && entry.type === "message" && entry.message?.role === "user") {
        latestUserIndex = index;
      }
      if (entry.type !== "custom" || entry.customType !== INFERENCE_ENTRY) continue;
      if (latestUserIndex > index) return;
      try {
        state.setSemantic(parseInference(entry.data));
      } catch {
        state.setSemantic(undefined);
      }
      return;
    }
  }

  type InferenceKind = "active" | "settled";

  function startInference(
    ctx: ExtensionContext,
    config: ProgressConfig,
    kind: InferenceKind,
    expectedGeneration: number,
  ): void {
    cancelInference();
    const controller = new AbortController();
    inferenceController = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error("progress inference timed out");
        controller.abort(error);
        reject(error);
      }, config.timeoutMs);
    });

    let request!: Promise<void>;
    request = (async () => {
      try {
        const { model, thinkingLevel } = resolveInferenceModel(ctx, config.model!);
        const response = await Promise.race([
          completeInference(
            ctx,
            model,
            inferenceRequest(digest.snapshot(), config),
            config,
            thinkingLevel,
            controller.signal,
          ),
          timedOut,
        ]);
        if (controller.signal.aborted || state.generation() !== expectedGeneration || ctx !== currentContext) return;
        const semantic = inferenceFromCompletion(response);
        state.setSemantic(semantic);
        lastInferenceError = undefined;
        if (kind === "settled") pi.appendEntry(INFERENCE_ENTRY, semantic);
        scheduleRender(ctx);
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason?.message !== "progress inference timed out") return;
        if (state.generation() === expectedGeneration && ctx === currentContext) reportInferenceError(ctx, error);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (inferenceController === controller) inferenceController = undefined;
      }
    })();
    inferencePromise = request;
    void request.finally(() => {
      if (inferencePromise === request) inferencePromise = undefined;
    });
  }

  function inferActiveRun(ctx: ExtensionContext): void {
    if (
      activeInferenceCount >= MAX_ACTIVE_INFERENCES_PER_RUN ||
      !state.snapshot().agentActive ||
      !digest.meaningful()
    ) return;
    if (activeInferenceTimer !== undefined) clearTimeout(activeInferenceTimer);
    const generation = state.generation();
    activeInferenceTimer = setTimeout(() => {
      activeInferenceTimer = undefined;
      void loadConfig()
        .then((config) => {
          configuredModel = config.model;
          if (
            !config.model ||
            !state.snapshot().agentActive ||
            generation !== state.generation() ||
            ctx !== currentContext ||
            activeInferenceCount >= MAX_ACTIVE_INFERENCES_PER_RUN
          ) return;
          activeInferenceCount += 1;
          startInference(ctx, config, "active", generation);
        })
        .catch((error) => {
          if (generation === state.generation() && ctx === currentContext) reportInferenceError(ctx, error);
        });
    }, ACTIVE_INFERENCE_DEBOUNCE_MS);
  }

  function inferSettledRun(ctx: ExtensionContext): void {
    if (!digest.meaningful()) return;
    const generation = state.generation();
    void loadConfig()
      .then((config) => {
        configuredModel = config.model;
        if (!config.model || generation !== state.generation() || ctx !== currentContext) return;
        startInference(ctx, config, "settled", generation);
      })
      .catch((error) => {
        if (generation === state.generation() && ctx === currentContext) reportInferenceError(ctx, error);
      });
  }

  function resetSession(ctx?: ExtensionContext): void {
    cancelInference();
    state.reset();
    digest.reset();
    lastInferenceError = undefined;
    configuredModel = null;
    activeInferenceCount = 0;
    if (ctx) restoreSemantic(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    warned = false;
    resetSession(ctx);
    render(ctx);
  });

  function invalidatePendingInference(): void {
    cancelInference();
    state.invalidateInference();
    state.setSemantic(undefined);
  }

  function isCurrentContext(ctx: ExtensionContext): boolean {
    if (currentContext && currentContext !== ctx) return false;
    currentContext ??= ctx;
    return true;
  }

  pi.on("session_before_switch", invalidatePendingInference);
  pi.on("session_before_fork", invalidatePendingInference);
  pi.on("session_before_tree", invalidatePendingInference);

  pi.on("session_tree", (_event, ctx) => {
    currentContext = ctx;
    resetSession(ctx);
    scheduleRender(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!isCurrentContext(ctx)) return;
    cancelInference();
    const previous = state.semantic();
    activeInferenceCount = 0;
    state.beginRun();
    digest.begin(event.prompt ?? "", previous);
    scheduleRender(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isCurrentContext(ctx)) return;
    cancelInference();
    if (!state.snapshot().agentActive) {
      const previous = state.semantic();
      activeInferenceCount = 0;
      state.beginRun();
      digest.begin("", previous);
    } else {
      state.invalidateInference();
      state.setSemantic(undefined);
    }
    scheduleRender(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!isCurrentContext(ctx)) return;
    state.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
    digest.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
    noteActivity(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isCurrentContext(ctx)) return;
    state.updateTool(event.toolCallId, event.toolName, event.input, ctx.cwd);
    digest.updateTool(event.toolCallId, event.toolName, event.input, ctx.cwd);
    noteActivity(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isCurrentContext(ctx)) return;
    const meaningful = digest.meaningfulTool(event.toolName, event.input, ctx.cwd, event.isError);
    state.finishTool(event.toolCallId, event.toolName, event.input, ctx.cwd, event.isError);
    digest.finishTool(event.toolCallId, event.toolName, event.input, ctx.cwd, event.isError);
    noteActivity(ctx);
    if (meaningful) inferActiveRun(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (ctx && !isCurrentContext(ctx)) return;
    const activeContext = ctx ?? currentContext;
    if (!activeContext) return;
    digest.setFinalAssistant(textOf(event.message.content));
    noteActivity(activeContext);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!isCurrentContext(ctx)) return;
    cancelInference();
    state.settleRun();
    state.setSemantic(undefined);
    digest.settle();
    scheduleRender(ctx);
    inferSettledRun(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cancelInference();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (ctx === currentContext) currentContext = undefined;
    state.reset();
    digest.reset();
    activeInferenceCount = 0;
  });

  pi.registerCommand("progress", {
    description: "[status | model [provider/model[:thinking]|off]] — Show or configure progress inference",
    getArgumentCompletions: (prefix) => {
      if (/^model\s/i.test(prefix)) {
        return completeModelArgument(prefix, currentContext, [
          { value: "model off", label: "off", description: "Disable progress inference" },
        ]);
      }
      return completeArguments(prefix, [
        { value: "status", label: "status", description: "Show inference status and configuration" },
        { value: "model ", label: "model", description: "Show or select the inference model" },
      ]);
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const [action, ...rest] = input.split(/\s+/).filter(Boolean);
      try {
        const config = await loadConfig();

        if (!action || action === "status") {
          configuredModel = config.model;
          ctx.ui.notify([
            `inference: ${config.model ? (inferencePromise ? "running" : "enabled") : "disabled"}`,
            `model: ${configuredModel ?? "none"}`,
            `last error: ${lastInferenceError ?? "none"}`,
            `config: ${configPath()}`,
          ].join("\n"), "info");
          return;
        }

        if (action === "model") {
          const reference = rest.join(" ").trim();
          if (!reference) {
            ctx.ui.notify(`Progress model: ${config.model ?? "off"}`, "info");
            return;
          }
          if (reference !== "off" && !isInferenceModelReference(reference)) {
            throw new Error("usage: /progress model <provider/model[:off|minimal|low|medium|high|xhigh|max]|off>");
          }
          config.model = reference === "off" ? null : reference;
          await saveConfig(config);
          configuredModel = config.model;
          cancelInference();
          state.invalidateInference();
          state.setSemantic(undefined);
          lastInferenceError = undefined;
          scheduleRender(ctx);
          ctx.ui.notify(`Progress model: ${config.model ?? "off"}`, "info");
          return;
        }

        throw new Error("usage: /progress [status|model <provider/model[:off|minimal|low|medium|high|xhigh|max]|off>]");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
