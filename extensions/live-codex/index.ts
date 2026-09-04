import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  EditorComponent,
  EditorTheme,
  TUI,
} from "@earendil-works/pi-tui";
import {
  BACKGROUND_ACTIVITY_FINISHED_EVENT,
  BACKGROUND_ACTIVITY_STARTED_EVENT,
} from "./background-activity.ts";
import {
  CONFIRMATION_CANCELLED_EVENT,
  CONFIRMATION_REQUESTED_EVENT,
} from "./confirmation.ts";
import { LiveSession } from "./controller.ts";
import { loadDroppedImages } from "./image-attachments.ts";
import { acquireVoiceLock, type VoiceLock } from "./voice-lock.ts";
import { LiveVisualizer } from "./visualizer.ts";

type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

class LiveExtensionRuntime {
  readonly #pi: ExtensionAPI;
  #session: LiveSession | undefined;
  #voiceLock: VoiceLock | undefined;
  #context: ExtensionContext | undefined;
  #visualizer: LiveVisualizer | undefined;
  #animation: NodeJS.Timeout | undefined;
  #previousEditor: EditorFactory | undefined;
  #previousText = "";

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  async toggle(context: ExtensionContext, voice: string): Promise<void> {
    if (this.#session) {
      await this.stop();
      return;
    }
    if (context.mode !== "tui") {
      context.ui.notify("/live requires Pi's interactive TUI", "error");
      return;
    }

    if (this.#voiceLock) {
      try {
        this.#voiceLock.release();
        this.#voiceLock = undefined;
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
    }

    const previousEditor = context.ui.getEditorComponent();
    const previousText = context.ui.getEditorText();
    try {
      this.#voiceLock = acquireVoiceLock(
        context.sessionManager.getSessionId(),
      );
    } catch (error) {
      context.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    this.#context = context;
    this.#previousEditor = previousEditor;
    this.#previousText = previousText;

    let session: LiveSession | undefined;
    let pendingError: Error | undefined;
    try {
      session = new LiveSession({
        pi: this.#pi,
        context,
        voice,
        callbacks: {
          onPhase: (phase) => this.#visualizer?.setPhase(phase),
          onInputLevel: (level) => this.#visualizer?.setInputLevel(level),
          onTranscript: (text) => this.#visualizer?.setTranscript(text),
          onAttachmentsChanged: (count) =>
            this.#visualizer?.setAttachmentCount(count),
          onWorkStatus: (status) => this.#visualizer?.setWorkStatus(status),
          onTerminal: (error) =>
            session && this.#finish(session, error ?? pendingError),
        },
      });
      this.#session = session;
      const activeSession = session;

      context.ui.setEditorComponent((tui, editorTheme, keybindings) => {
        const visualizer = new LiveVisualizer(
          tui,
          editorTheme,
          keybindings,
          context.ui.theme,
          {
            onStop: () => void this.stop(),
            onToggleMute: () => activeSession.toggleMute(),
            onDrop: (data) =>
              void this.#attachDroppedImages(activeSession, data),
          },
        );
        this.#visualizer = visualizer;
        return visualizer;
      });
      context.ui.setStatus("pi-live-codex", "connecting");
      this.#animation = setInterval(() => {
        this.#visualizer?.advanceFrame();
      }, 80);

      await session.start();
      if (this.#session === session) {
        context.ui.setStatus("pi-live-codex", "live");
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      pendingError = error;
      if (session) {
        try {
          await session.stop();
        } catch {}
        this.#finish(session, error);
      } else {
        this.#reset(error);
      }
    }
  }

  async #attachDroppedImages(
    session: LiveSession,
    data: string,
  ): Promise<void> {
    const context = this.#context;
    if (!context || this.#session !== session) return;
    try {
      const attachments = await session.loadImages(() =>
        loadDroppedImages(data, context.cwd),
      );
      if (this.#session !== session) return;
      if (attachments.length === 0) {
        context.ui.notify("Drop one or more image files while live", "warning");
        return;
      }
      context.ui.notify(
        `Attached ${attachments.map(({ name }) => name).join(", ")}`,
        "info",
      );
    } catch (cause) {
      if (this.#session !== session) return;
      context.ui.notify(
        cause instanceof Error ? cause.message : String(cause),
        "error",
      );
    }
  }

  handleAgentMessage(message: AgentMessage): void {
    this.#session?.handleAgentMessage(message);
  }

  handleAgentSettled(): void {
    this.#session?.handleAgentSettled();
  }

  handleToolCallStarted(toolCallId: string): void {
    this.#session?.handleToolCallStarted(toolCallId);
  }

  handleBackgroundActivityStarted(event: unknown): void {
    this.#session?.handleBackgroundActivityStarted(event);
  }

  handleBackgroundActivityFinished(event: unknown): void {
    this.#session?.handleBackgroundActivityFinished(event);
  }

  handleConfirmationRequested(event: unknown): void {
    this.#session?.handleConfirmationRequested(event);
  }

  handleConfirmationCancelled(event: unknown): void {
    this.#session?.handleConfirmationCancelled(event);
  }

  handleAsyncJobStarted(event: unknown): void {
    this.#session?.handleAsyncJobStarted(event);
  }

  handleAsyncJobCompleted(event: unknown): void {
    this.#session?.handleAsyncJobCompleted(event);
  }

  async stop(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      await session.stop();
    } finally {
      this.#finish(session);
    }
  }

  #finish(session: LiveSession, error?: Error): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    this.#reset(error);
  }

  #reset(error?: Error): void {
    clearInterval(this.#animation);
    this.#animation = undefined;
    this.#visualizer = undefined;
    const context = this.#context;
    this.#context = undefined;
    const previousEditor = this.#previousEditor;
    const previousText = this.#previousText;
    this.#previousEditor = undefined;
    this.#previousText = "";
    try {
      this.#voiceLock?.release();
      this.#voiceLock = undefined;
    } catch (cause) {
      error ??= cause instanceof Error ? cause : new Error(String(cause));
    }
    if (!context) return;
    try {
      context.ui.setStatus("pi-live-codex", undefined);
      context.ui.setEditorComponent(previousEditor);
      context.ui.setEditorText(previousText);
    } catch (cause) {
      error ??= cause instanceof Error ? cause : new Error(String(cause));
    }
    if (error) context.ui.notify(error.message, "error");
  }
}

export default function piLiveCodex(pi: ExtensionAPI): void {
  const runtime = new LiveExtensionRuntime(pi);

  pi.registerCommand("live", {
    description: "Start or stop gpt-live-1-codex voice mode",
    handler: async (args, context) => {
      await runtime.toggle(context, args.trim() || "sol");
    },
  });

  pi.registerShortcut("ctrl+l", {
    description: "Toggle gpt-live-1-codex voice mode",
    handler: async (context) => {
      await runtime.toggle(context, "sol");
    },
  });

  pi.on("message_end", (event) => {
    runtime.handleAgentMessage(event.message);
  });

  pi.on("agent_settled", () => {
    runtime.handleAgentSettled();
  });

  pi.on("tool_execution_start", (event) => {
    runtime.handleToolCallStarted(event.toolCallId);
  });

  const unsubscribeBackgroundStarted = pi.events.on(
    BACKGROUND_ACTIVITY_STARTED_EVENT,
    (event) => runtime.handleBackgroundActivityStarted(event),
  );
  const unsubscribeBackgroundFinished = pi.events.on(
    BACKGROUND_ACTIVITY_FINISHED_EVENT,
    (event) => runtime.handleBackgroundActivityFinished(event),
  );
  const unsubscribeConfirmationRequested = pi.events.on(
    CONFIRMATION_REQUESTED_EVENT,
    (event) => runtime.handleConfirmationRequested(event),
  );
  const unsubscribeConfirmationCancelled = pi.events.on(
    CONFIRMATION_CANCELLED_EVENT,
    (event) => runtime.handleConfirmationCancelled(event),
  );
  const unsubscribeAsyncStarted = pi.events.on(
    "subagent:async-started",
    (event) => runtime.handleAsyncJobStarted(event),
  );
  const unsubscribeAsyncCompleted = pi.events.on(
    "subagent:async-complete",
    (event) => runtime.handleAsyncJobCompleted(event),
  );

  pi.on("session_shutdown", async () => {
    unsubscribeBackgroundStarted();
    unsubscribeBackgroundFinished();
    unsubscribeConfirmationRequested();
    unsubscribeConfirmationCancelled();
    unsubscribeAsyncStarted();
    unsubscribeAsyncCompleted();
    await runtime.stop();
  });
}
