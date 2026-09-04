// Adapted from Oh My Pi's MIT-licensed live session controller.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ActivityTracker, type WorkStatus } from "./activity-tracker.ts";
import type { ImageAttachment } from "./image-attachments.ts";
import { AudioCapture } from "./native.cjs";
import {
  buildDelegationContextAppend,
  buildSessionClose,
  buildSessionContextAppend,
  chunkLiveContext,
  type LiveClientMessage,
  type LiveServerEvent,
} from "./protocol.ts";
import { CodexLiveTransport } from "./transport.ts";
import type { LivePhase } from "./visualizer.ts";

const OUTPUT_ACTIVE_LEVEL = 0.015;
const OUTPUT_RELEASE_DELAY_MS = 250;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
const LIVE_DELEGATION_MESSAGE_TYPE = "pi-live-codex-delegation";
const CANCEL_CURRENT_REQUEST = "[[live:cancel-current]]";

const LIVE_INSTRUCTIONS = `You are the realtime voice surface of one unified coding assistant.

The user speaks to you. Respond directly, briefly, conversationally, and without markdown unless asked for detail.

The Pi coding agent is your execution surface with repository context and tools. For coding, investigation, repository changes, commands, or verification, promptly create a client delegation containing the complete request and relevant conversational context. Do not attempt repository work yourself. A new request while work is active must create another client delegation. Independent requests are queued by the client so they remain correctly correlated; do not assume they steer an earlier request.

When the user unambiguously asks to stop the foreground operation currently being performed, create a client delegation whose entire text is exactly ${CANCEL_CURRENT_REQUEST}. Requests to cancel a named or previously launched background activity are ordinary client delegations containing the target and conversational context; the Pi agent will resolve and cancel the owned job.

Treat delegation context as your own internal progress and results. Never mention a backend, delegation, protocol, or separate assistant. Commentary context is silent progress for conversational continuity. Context beginning with "Agent Final Message": is the completed result; present its useful content naturally as your own. Session context beginning with "Background Activity Final": is a later result from work you previously acknowledged; briefly tell the user what finished. Never claim work or verification before a result arrives.`;

export interface LiveSessionCallbacks {
  onPhase(phase: LivePhase): void;
  onInputLevel(level: number): void;
  onTranscript(text: string): void;
  onAttachmentsChanged(count: number): void;
  onWorkStatus(status: WorkStatus): void;
  onTerminal(error?: Error): void;
}

export interface LiveSessionOptions {
  pi: ExtensionAPI;
  context: ExtensionContext;
  callbacks: LiveSessionCallbacks;
  voice?: string;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function microphoneLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.min(1, Math.sqrt(squares / samples.length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate
    : undefined;
}

function completionState(
  event: Record<string, unknown>,
): "completed" | "failed" | "cancelled" {
  const state = stringField(event, "state");
  if (state === "stopped" || state === "cancelled") return "cancelled";
  return event.success === true || state === "complete" || state === "completed"
    ? "completed"
    : "failed";
}

export class OutputActivityLatch {
  readonly #onChange: (active: boolean) => void;
  readonly #releaseDelayMs: number;
  #active = false;
  #releaseTimer: NodeJS.Timeout | undefined;

  constructor(
    onChange: (active: boolean) => void,
    releaseDelayMs = OUTPUT_RELEASE_DELAY_MS,
  ) {
    this.#onChange = onChange;
    this.#releaseDelayMs = releaseDelayMs;
  }

  update(active: boolean): void {
    if (active) {
      clearTimeout(this.#releaseTimer);
      this.#releaseTimer = undefined;
      if (!this.#active) {
        this.#active = true;
        this.#onChange(true);
      }
      return;
    }
    if (!this.#active || this.#releaseTimer) return;
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = undefined;
      this.#active = false;
      this.#onChange(false);
    }, this.#releaseDelayMs);
  }

  dispose(): void {
    clearTimeout(this.#releaseTimer);
    this.#releaseTimer = undefined;
  }
}

export class LiveSession {
  readonly #pi: ExtensionAPI;
  readonly #context: ExtensionContext;
  readonly #callbacks: LiveSessionCallbacks;
  readonly #voice: string;
  #transport: CodexLiveTransport | undefined;
  #recorder: AudioCapture | undefined;
  #sendTail: Promise<void> = Promise.resolve();
  #actionTail: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | undefined;
  readonly #activities = new ActivityTracker();
  #outputLevel = 0;
  #outputActive = false;
  readonly #outputActivity: OutputActivityLatch;
  #muted = false;
  #stopped = false;
  #terminalError: Error | undefined;
  #terminalEmitted = false;
  #inputTranscript = "";
  #attachments: ImageAttachment[] = [];
  readonly #delegationAttachments = new Map<string, ImageAttachment[]>();
  #attachmentLoadTail: Promise<void> = Promise.resolve();

  constructor(options: LiveSessionOptions) {
    this.#pi = options.pi;
    this.#context = options.context;
    this.#callbacks = options.callbacks;
    this.#voice = options.voice?.trim() || "sol";
    this.#outputActivity = new OutputActivityLatch((active) => {
      this.#outputActive = active;
      this.#refreshPhase();
    });
  }

  async start(): Promise<void> {
    this.#callbacks.onPhase("connecting");
    try {
      const transport = new CodexLiveTransport({
        sessionId: this.#context.sessionManager.getSessionId(),
        instructions: LIVE_INSTRUCTIONS,
        voice: this.#voice,
        getAccess: async () => {
          const auth = await this.#context.modelRegistry.getProviderAuth(
            "openai-codex",
          );
          const accessToken = auth?.auth.apiKey;
          if (!accessToken) {
            throw new Error(
              "No OpenAI Codex OAuth credential. Run /login openai-codex first.",
            );
          }
          return { accessToken };
        },
        callbacks: {
          onEvent: (event) => this.#handleLiveEvent(event),
          onOutputLevel: (level) => {
            this.#outputLevel = level;
            this.#outputActivity.update(level > OUTPUT_ACTIVE_LEVEL);
          },
        },
      });
      this.#transport = transport;
      await transport.connect();
      if (this.#stopped) return;
      this.#recorder = new AudioCapture(16_000, (error, samples) => {
        if (error) {
          this.#fail(error);
          return;
        }
        this.#handleMicrophoneAudio(samples);
      });
      this.#refreshPhase();
    } catch (cause) {
      this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    }
  }

  async loadImages(
    load: () => Promise<ImageAttachment[]>,
  ): Promise<ImageAttachment[]> {
    let loaded: ImageAttachment[] = [];
    const task = this.#attachmentLoadTail.then(async () => {
      loaded = await load();
      if (this.#stopped || loaded.length === 0) return;
      this.#attachments.push(...loaded);
      this.#callbacks.onAttachmentsChanged(this.#attachments.length);
    });
    this.#attachmentLoadTail = task.catch(() => {});
    await task;
    return loaded;
  }

  toggleMute(): void {
    if (this.#stopped) return;
    this.#muted = !this.#muted;
    this.#transport?.setMuted(this.#muted);
    if (this.#muted) this.#callbacks.onInputLevel(0);
    this.#refreshPhase();
  }

  handleAgentMessage(message: AgentMessage): void {
    if (message.role !== "assistant" || !this.#activities.active()) return;
    const text = assistantText(message);
    if (!text) return;
    if (message.stopReason === "toolUse") {
      this.#appendDelegationContext(
        this.#activities.active()!.id,
        text,
        "commentary",
      );
    } else {
      this.#activities.setPendingFinal(text);
    }
  }

  handleAgentSettled(): void {
    this.#queueAction(() => {
      const settled = this.#activities.settleActive();
      if (settled?.pendingFinal) {
        this.#appendDelegationContext(
          settled.id,
          `"Agent Final Message":\n\n${settled.pendingFinal}`,
        );
      }
      this.#emitWorkStatus();
      this.#dispatchNext();
    });
  }

  handleAsyncJobStarted(event: unknown): void {
    if (!isRecord(event)) return;
    const jobId = stringField(event, "runId") ?? stringField(event, "id");
    if (!jobId || !this.#eventBelongsToSession(event)) return;
    this.#queueAction(() => {
      const owner = this.#activities.associateJob(jobId);
      if (!owner) return;
      this.#persistActivity("job-started", owner.id, jobId);
      this.#emitWorkStatus();
    });
  }

  handleAsyncJobCompleted(event: unknown): void {
    if (!isRecord(event)) return;
    const jobId = stringField(event, "runId") ?? stringField(event, "id");
    if (!jobId) return;
    this.#queueAction(() => {
      const state = completionState(event);
      const owner = this.#activities.completeJob(jobId, state);
      if (!owner) return;
      const summary = stringField(event, "summary")?.trim();
      const outcome = state === "completed" ? "completed" : state;
      const detail = summary
        ? `\n\n${summary.slice(0, 4_000)}`
        : "";
      this.#queueSend(
        buildSessionContextAppend(
          `Background Activity Final:\n\n${owner.request}\n\nStatus: ${outcome}.${detail}`,
          "speakable",
        ),
      );
      this.#persistActivity("job-completed", owner.id, jobId, {
        state,
        ...(summary ? { summary: summary.slice(0, 4_000) } : {}),
      });
      this.#emitWorkStatus();
    });
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#outputActivity.dispose();
    try {
      const recorder = this.#recorder;
      this.#recorder = undefined;
      try {
        recorder?.stop();
      } catch {}
      try {
        await this.#attachmentLoadTail;
        await this.#actionTail;
        await this.#sendTail;
      } catch {}
      const transport = this.#transport;
      this.#transport = undefined;
      if (transport) {
        try {
          await transport.send(buildSessionClose());
        } catch {}
        try {
          await transport.close();
        } catch {}
      }
    } finally {
      this.#emitTerminal(this.#terminalError);
    }
  }

  #handleLiveEvent(event: LiveServerEvent): void {
    if (this.#stopped) return;
    switch (event.type) {
      case "session.started":
        this.#refreshPhase();
        break;
      case "input_transcript.added":
        this.#inputTranscript = event.item.text.startsWith(this.#inputTranscript)
          ? event.item.text
          : this.#inputTranscript + event.item.text;
        this.#callbacks.onTranscript(this.#inputTranscript.trim());
        break;
      case "turn.done":
        if (event.turn.role === "user") {
          this.#inputTranscript = "";
          this.#callbacks.onTranscript("");
        }
        break;
      case "delegation.created":
        this.#queueAction(() => this.#handleDelegation(event));
        break;
      case "error":
        this.#fail(new Error(event.message));
        break;
      case "session.updated":
      case "output_audio.delta":
      case "output_transcript.added":
      case "unknown":
        break;
    }
  }

  async #handleDelegation(
    event: Extract<LiveServerEvent, { type: "delegation.created" }>,
  ): Promise<void> {
    await this.#attachmentLoadTail;
    if (this.#stopped) return;
    const request = event.item.content
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!request) return;
    if (request === CANCEL_CURRENT_REQUEST) {
      const wasActive = !this.#context.isIdle();
      if (wasActive) this.#context.abort();
      this.#appendDelegationContext(
        event.item.id,
        `"Agent Final Message":\n\n${wasActive ? "I stopped the current operation." : "There isn't a foreground operation to stop."}`,
      );
      return;
    }
    if (!this.#activities.enqueue(event.item.id, request)) return;
    const attachments = this.#attachments.splice(0);
    this.#delegationAttachments.set(event.item.id, attachments);
    this.#callbacks.onAttachmentsChanged(0);
    this.#persistActivity("queued", event.item.id);
    this.#emitWorkStatus();
    this.#inputTranscript = "";
    this.#callbacks.onTranscript("");
    this.#dispatchNext();
  }

  #dispatchNext(): void {
    if (this.#stopped || !this.#context.isIdle()) return;
    const delegation = this.#activities.activateNext();
    if (!delegation) return;
    const attachments = this.#delegationAttachments.get(delegation.id) ?? [];
    this.#delegationAttachments.delete(delegation.id);
    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: delegation.request },
      ...attachments.map((attachment) => attachment.content),
    ];
    try {
      this.#pi.sendMessage(
        {
          customType: LIVE_DELEGATION_MESSAGE_TYPE,
          content,
          display: true,
          details: {
            delegationId: delegation.id,
            attachments: attachments.map(({ name }) => name),
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      this.#persistActivity("active", delegation.id);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#appendDelegationContext(
        delegation.id,
        `"Agent Final Message":\n\nI couldn't start that request: ${error.message}`,
      );
      this.#activities.failActive();
      this.#persistActivity("failed", delegation.id, undefined, {
        error: error.message,
      });
      this.#dispatchNext();
    }
    this.#emitWorkStatus();
    this.#refreshPhase();
  }

  #appendDelegationContext(
    delegationId: string,
    text: string,
    channel?: "speakable" | "commentary",
  ): void {
    for (const chunk of chunkLiveContext(text)) {
      this.#queueSend(
        buildDelegationContextAppend(delegationId, chunk, channel),
      );
    }
  }

  #queueAction(action: () => void | Promise<void>): void {
    this.#actionTail = this.#actionTail
      .then(action)
      .catch((cause) => {
        this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
      });
  }

  #queueSend(message: LiveClientMessage): void {
    const transport = this.#transport;
    if (!transport || this.#stopped) return;
    this.#sendTail = this.#sendTail
      .then(async () => {
        if (!this.#stopped) await transport.send(message);
      })
      .catch((cause) => {
        this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
      });
  }

  #handleMicrophoneAudio(samples: Float32Array): void {
    if (this.#stopped || this.#muted || !this.#transport) return;
    const inputLevel = microphoneLevel(samples);
    this.#callbacks.onInputLevel(inputLevel);
    const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
    const echoThreshold = Math.max(
      MIN_BARGE_IN_LEVEL,
      this.#outputLevel * OUTPUT_ECHO_RATIO,
    );
    if (!outputActive || inputLevel >= echoThreshold) {
      this.#transport.pushAudio(samples);
    }
  }

  #refreshPhase(): void {
    if (this.#stopped) return;
    if (this.#muted) this.#callbacks.onPhase("muted");
    else if (
      this.#activities.status().active > 0 ||
      this.#activities.status().queued > 0
    ) this.#callbacks.onPhase("working");
    else if (this.#outputActive) this.#callbacks.onPhase("speaking");
    else this.#callbacks.onPhase("listening");
  }

  #eventBelongsToSession(event: Record<string, unknown>): boolean {
    const eventSession = stringField(event, "sessionId");
    if (!eventSession) return true;
    return eventSession ===
      (this.#context.sessionManager.getSessionFile() ??
        this.#context.sessionManager.getSessionId());
  }

  #persistActivity(
    type: string,
    delegationId: string,
    jobId?: string,
    details: Record<string, unknown> = {},
  ): void {
    this.#pi.appendEntry("pi-live-codex-activity", {
      version: 1,
      type,
      delegationId,
      ...(jobId ? { jobId } : {}),
      ...details,
      timestamp: Date.now(),
    });
  }

  #emitWorkStatus(): void {
    this.#callbacks.onWorkStatus(this.#activities.status());
  }

  #fail(error: Error): void {
    if (this.#terminalEmitted || this.#terminalError) return;
    this.#terminalError = error;
    this.#callbacks.onPhase("error");
    void this.stop();
  }

  #emitTerminal(error?: Error): void {
    if (this.#terminalEmitted) return;
    this.#terminalEmitted = true;
    this.#callbacks.onTerminal(error);
  }
}
