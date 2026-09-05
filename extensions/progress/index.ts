import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderProgress } from "./render.ts";
import { ProgressState } from "./state.ts";

const WIDGET_KEY = "pi-progress";

export default function progressExtension(pi: ExtensionAPI): void {
  const state = new ProgressState();
  let currentContext: ExtensionContext | undefined;
  let renderScheduled = false;

  function render(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx !== currentContext) return;
    const snapshot = state.snapshot();
    const hasFacts =
      snapshot.runStarted ||
      snapshot.agentActive ||
      snapshot.tools.length > 0 ||
      snapshot.checks.length > 0 ||
      snapshot.touchedPaths.length > 0;
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

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    state.reset();
    render(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    state.beginRun();
    scheduleRender(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!state.snapshot().agentActive) state.beginRun();
    scheduleRender(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    state.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
    scheduleRender(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    state.updateTool(event.toolCallId, event.toolName, event.input, ctx.cwd);
    scheduleRender(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    state.finishTool(
      event.toolCallId,
      event.toolName,
      event.input,
      ctx.cwd,
      event.isError,
    );
    scheduleRender(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    state.settleRun();
    scheduleRender(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (ctx === currentContext) currentContext = undefined;
    state.reset();
  });
}
