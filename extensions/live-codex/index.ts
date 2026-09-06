import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  EditorComponent,
  EditorTheme,
  TUI,
} from "@earendil-works/pi-tui";
import { withHerdrBlocked } from "../shared/herdr-blocked.ts";
import {
  BACKGROUND_ACTIVITY_FINISHED_EVENT,
  BACKGROUND_ACTIVITY_STARTED_EVENT,
} from "./background-activity.ts";
import {
  CONFIRMATION_CANCELLED_EVENT,
  CONFIRMATION_REQUESTED_EVENT,
} from "./confirmation.ts";
import { LiveSession, type LiveStopMode } from "./controller.ts";
import { loadDroppedImages } from "./image-attachments.ts";
import {
  acquireVoiceLock,
  requestVoiceLockHandoff,
  VoiceLockHeldError,
  type VoiceLock,
  type VoiceLockHandoffRequest,
  type VoiceLockHandoffResponse,
} from "./voice-lock.ts";
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  LiveVisualizer,
} from "./visualizer.ts";

export const LIVE_TRANSCRIPT_LIMIT_FLAG = "live-transcript-limit";

const LIVE_VOICES = [
  "sol",
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

function completeVoices(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trimStart().toLowerCase();
  const matches = LIVE_VOICES
    .filter((voice) => voice.includes(query))
    .map((voice) => ({
      value: voice,
      label: voice,
      description: voice === "sol" ? "Default voice" : "Realtime voice",
    }));
  return matches.length > 0 ? matches : null;
}

export function combineRestoredDrafts(
  previousText: string,
  pendingTypedNote: string | undefined,
  liveDraft = "",
): string {
  return [previousText, pendingTypedNote ?? "", liveDraft]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function parseTranscriptLimit(
  value: string | boolean | undefined,
): number {
  if (value === undefined) return DEFAULT_TRANSCRIPT_LIMIT;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error("--live-transcript-limit must be a positive integer");
  }
  const limit = Number(value.trim());
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("--live-transcript-limit must be a positive integer");
  }
  return limit;
}

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

  async toggle(
    context: ExtensionContext,
    voice: string,
    transcriptLimit: string | boolean | undefined,
  ): Promise<void> {
    if (this.#session) {
      await this.stop();
      return;
    }
    if (context.mode !== "tui") {
      context.ui.notify("/live requires Pi's interactive TUI", "error");
      return;
    }

    let parsedTranscriptLimit: number;
    try {
      parsedTranscriptLimit = parseTranscriptLimit(transcriptLimit);
    } catch (cause) {
      context.ui.notify(
        cause instanceof Error ? cause.message : String(cause),
        "error",
      );
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
    const sessionId = context.sessionManager.getSessionId();
    try {
      let voiceLock: VoiceLock;
      try {
        voiceLock = await acquireVoiceLock(sessionId);
      } catch (error) {
        if (!(error instanceof VoiceLockHeldError) || !error.owner) throw error;
        const owner = error.owner;
        const moveVoice = await withHerdrBlocked(
          this.#pi,
          "Voice handoff approval required",
          () => context.ui.confirm(
            "Move voice mode here?",
            `Another Pi session currently owns live voice (PID ${owner.pid}, session ${owner.sessionId}). Move voice controls here? Work already running in that session will continue there; only voice controls move to this session.`,
          ),
        );
        if (!moveVoice) {
          context.ui.notify(
            "Voice mode remains active in the other Pi session.",
            "info",
          );
          return;
        }
        const handoff = await requestVoiceLockHandoff(owner, sessionId);
        if (!handoff.accepted) {
          context.ui.notify(
            handoff.reason ?? "The other Pi session declined the voice handoff.",
            "warning",
          );
          return;
        }
        voiceLock = await acquireVoiceLock(sessionId);
      }
      this.#voiceLock = voiceLock;
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
          onUserTranscript: (text, finalized, startsNew) =>
            this.#visualizer?.setUserTranscript(text, finalized, startsNew),
          onAgentTranscript: (text, finalized, startsNew) =>
            this.#visualizer?.setAgentTranscript(text, finalized, startsNew),
          onAttachmentsChanged: (count) =>
            this.#visualizer?.setAttachmentCount(count),
          onWorkStatus: (status) => this.#visualizer?.setWorkStatus(status),
          onTerminal: (error) =>
            session && this.#finish(session, error ?? pendingError),
        },
      });
      this.#session = session;
      this.#voiceLock?.setHandoffHandler((request) =>
        this.#handleHandoff(request),
      );
      const activeSession = session;

      context.ui.setEditorComponent((tui, editorTheme, keybindings) => {
        const visualizer = new LiveVisualizer(
          tui,
          editorTheme,
          keybindings,
          context.ui.theme,
          {
            transcriptLimit: parsedTranscriptLimit,
            onStop: () => void this.stop(),
            onToggleMute: () => activeSession.toggleMute(),
            onDrop: (data) =>
              void this.#attachDroppedImages(activeSession, data),
            onTypedNote: (text) => activeSession.stageTypedNote(text),
          },
        );
        this.#visualizer = visualizer;
        return visualizer;
      });
      context.ui.setEditorText("");
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

  async stop(mode: LiveStopMode = "handoff"): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      await session.stop(mode);
    } finally {
      this.#finish(session);
    }
  }

  async #handleHandoff(
    _request: VoiceLockHandoffRequest,
  ): Promise<VoiceLockHandoffResponse> {
    const session = this.#session;
    if (!session) return { accepted: true };
    const blockers = session.handoffBlockers();
    if (blockers.length > 0) {
      return { accepted: false, reason: blockers.join(" ") };
    }
    try {
      await this.stop("handoff");
      return { accepted: true };
    } catch (cause) {
      return {
        accepted: false,
        reason: cause instanceof Error
          ? `Voice handoff could not stop the old voice session: ${cause.message}`
          : "Voice handoff could not stop the old voice session.",
      };
    }
  }

  #finish(session: LiveSession, error?: Error): void {
    if (this.#session !== session) return;
    const pendingTypedNote = session.takePendingTypedNote();
    this.#session = undefined;
    this.#reset(error, pendingTypedNote);
  }

  #reset(error?: Error, pendingTypedNote?: string): void {
    clearInterval(this.#animation);
    this.#animation = undefined;
    const context = this.#context;
    const liveDraft = context && this.#visualizer
      ? context.ui.getEditorText()
      : "";
    this.#visualizer = undefined;
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
      context.ui.setEditorText(
        combineRestoredDrafts(previousText, pendingTypedNote, liveDraft),
      );
    } catch (cause) {
      error ??= cause instanceof Error ? cause : new Error(String(cause));
    }
    if (error) context.ui.notify(error.message, "error");
  }
}

export default function piLiveCodex(pi: ExtensionAPI): void {
  const runtime = new LiveExtensionRuntime(pi);

  pi.registerFlag(LIVE_TRANSCRIPT_LIMIT_FLAG, {
    type: "string",
    description: "Number of live transcript utterances to retain",
    default: String(DEFAULT_TRANSCRIPT_LIMIT),
  });

  pi.registerCommand("live", {
    description: "[voice] — Start or stop gpt-live-1-codex voice mode (default: sol)",
    getArgumentCompletions: completeVoices,
    handler: async (args, context) => {
      await runtime.toggle(
        context,
        args.trim() || "sol",
        pi.getFlag(LIVE_TRANSCRIPT_LIMIT_FLAG),
      );
    },
  });

  pi.registerShortcut("ctrl+l", {
    description: "Toggle gpt-live-1-codex voice mode",
    handler: async (context) => {
      await runtime.toggle(
        context,
        "sol",
        pi.getFlag(LIVE_TRANSCRIPT_LIMIT_FLAG),
      );
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
    await runtime.stop("shutdown");
  });
}
