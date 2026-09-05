import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  let inferenceController: AbortController | undefined;
  let inferencePromise: Promise<void> | undefined;
  let lastInferenceError: string | undefined;
  let warned = false;
  let configuredModel: string | null = null;

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
    currentContext = ctx;
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      render(ctx);
    });
  }

  function cancelInference(): void {
    inferenceController?.abort();
    inferenceController = undefined;
    inferencePromise = undefined;
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

  function startInference(ctx: ExtensionContext, config: ProgressConfig): void {
    cancelInference();
    const controller = new AbortController();
    inferenceController = controller;
    const expectedGeneration = state.generation();
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
        pi.appendEntry(INFERENCE_ENTRY, semantic);
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

  function inferSettledRun(ctx: ExtensionContext): void {
    if (!digest.meaningful()) return;
    const generation = state.generation();
    void loadConfig()
      .then((config) => {
        configuredModel = config.model;
        if (!config.model || generation !== state.generation() || ctx !== currentContext) return;
        startInference(ctx, config);
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
    cancelInference();
    const previous = state.semantic();
    state.beginRun();
    digest.begin(event.prompt ?? "", previous);
    scheduleRender(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!state.snapshot().agentActive) {
      const previous = state.semantic();
      state.beginRun();
      digest.begin("", previous);
    }
    scheduleRender(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    state.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
    digest.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
    scheduleRender(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    state.updateTool(event.toolCallId, event.toolName, event.input, ctx.cwd);
    digest.updateTool(event.toolCallId, event.toolName, event.input, ctx.cwd);
    scheduleRender(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    state.finishTool(event.toolCallId, event.toolName, event.input, ctx.cwd, event.isError);
    digest.finishTool(event.toolCallId, event.toolName, event.input, ctx.cwd, event.isError);
    scheduleRender(ctx);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") digest.setFinalAssistant(textOf(event.message.content));
  });

  pi.on("agent_settled", (_event, ctx) => {
    state.settleRun();
    scheduleRender(ctx);
    inferSettledRun(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cancelInference();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (ctx === currentContext) currentContext = undefined;
    state.reset();
    digest.reset();
  });

  pi.registerCommand("progress", {
    description: "Show deterministic progress and inference status",
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
            throw new Error("usage: /progress model <provider/model[:off|minimal]|off>");
          }
          config.model = reference === "off" ? null : reference;
          await saveConfig(config);
          configuredModel = config.model;
          cancelInference();
          lastInferenceError = undefined;
          if (!config.model) {
            state.setSemantic(undefined);
            scheduleRender(ctx);
          }
          ctx.ui.notify(`Progress model: ${config.model ?? "off"}`, "info");
          return;
        }

        throw new Error("usage: /progress [status|model <provider/model[:off|minimal]|off>]");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
