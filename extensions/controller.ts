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
import type { ImageAttachment } from "./image-attachments.ts";
import { AudioCapture } from "./native.cjs";
import {
  buildDelegationContextAppend,
  buildSessionClose,
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

const LIVE_INSTRUCTIONS = `You are the realtime voice surface of one unified coding assistant.

The user speaks to you. Respond directly, briefly, conversationally, and without markdown unless asked for detail.

The Pi coding agent is your execution surface with repository context and tools. For coding, investigation, repository changes, commands, or verification, promptly create a client delegation containing the complete request and relevant conversational context. Do not attempt repository work yourself. A new request while work is active must create another client delegation so it can steer the same backend session.

Treat delegation context as your own internal progress and results. Never mention a backend, delegation, protocol, or separate assistant. Commentary context is silent progress for conversational continuity. Context beginning with "Agent Final Message": is the completed result; present its useful content naturally as your own. Never claim work or verification before that result arrives.`;

export interface LiveSessionCallbacks {
  onPhase(phase: LivePhase): void;
  onInputLevel(level: number): void;
  onTranscript(text: string): void;
  onAttachmentsChanged(count: number): void;
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
  #stopPromise: Promise<void> | undefined;
  #activeDelegationId: string | undefined;
  readonly #seenDelegationIds = new Set<string>();
  #pendingFinal = "";
  #outputLevel = 0;
  #outputActive = false;
  readonly #outputActivity: OutputActivityLatch;
  #muted = false;
  #stopped = false;
  #terminalError: Error | undefined;
  #terminalEmitted = false;
  #inputTranscript = "";
  #attachments: ImageAttachment[] = [];
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
    if (message.role !== "assistant" || !this.#activeDelegationId) return;
    const text = assistantText(message);
    if (!text) return;
    if (message.stopReason === "toolUse") {
      this.#appendDelegationContext(text, "commentary");
    } else {
      this.#pendingFinal = text;
    }
  }

  handleAgentSettled(): void {
    if (!this.#activeDelegationId || !this.#pendingFinal) return;
    this.#appendDelegationContext(
      `"Agent Final Message":\n\n${this.#pendingFinal}`,
    );
    this.#pendingFinal = "";
    this.#activeDelegationId = undefined;
    this.#refreshPhase();
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
        void this.#handleDelegation(event);
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
    if (this.#seenDelegationIds.has(event.item.id)) return;
    this.#seenDelegationIds.add(event.item.id);
    await this.#attachmentLoadTail;
    if (this.#stopped) return;
    const request = event.item.content
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!request) return;
    this.#activeDelegationId = event.item.id;
    this.#pendingFinal = "";
    this.#callbacks.onPhase("working");
    const attachments = this.#attachments.splice(0);
    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: request },
      ...attachments.map((attachment) => attachment.content),
    ];
    this.#callbacks.onAttachmentsChanged(0);
    this.#pi.sendMessage(
      {
        customType: LIVE_DELEGATION_MESSAGE_TYPE,
        content,
        display: true,
        details: {
          delegationId: event.item.id,
          attachments: attachments.map(({ name }) => name),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    this.#inputTranscript = "";
    this.#callbacks.onTranscript("");
  }

  #appendDelegationContext(
    text: string,
    channel?: "speakable" | "commentary",
  ): void {
    const delegationId = this.#activeDelegationId;
    if (!delegationId) return;
    for (const chunk of chunkLiveContext(text)) {
      this.#queueSend(
        buildDelegationContextAppend(delegationId, chunk, channel),
      );
    }
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
    else if (this.#activeDelegationId) this.#callbacks.onPhase("working");
    else if (this.#outputActive) this.#callbacks.onPhase("speaking");
    else this.#callbacks.onPhase("listening");
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
