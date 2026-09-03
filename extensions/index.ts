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
import { LiveSession } from "./controller.ts";
import { LiveVisualizer } from "./visualizer.ts";

type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

class LiveExtensionRuntime {
  readonly #pi: ExtensionAPI;
  #session: LiveSession | undefined;
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

    this.#context = context;
    this.#previousEditor = context.ui.getEditorComponent();
    this.#previousText = context.ui.getEditorText();

    const session = new LiveSession({
      pi: this.#pi,
      context,
      voice,
      callbacks: {
        onPhase: (phase) => this.#visualizer?.setPhase(phase),
        onInputLevel: (level) => this.#visualizer?.setInputLevel(level),
        onTranscript: (text) => this.#visualizer?.setTranscript(text),
        onTerminal: (error) => this.#finish(session, error),
      },
    });
    this.#session = session;

    context.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const visualizer = new LiveVisualizer(
        tui,
        editorTheme,
        keybindings,
        context.ui.theme,
        {
          onStop: () => void this.stop(),
          onToggleMute: () => session.toggleMute(),
        },
      );
      this.#visualizer = visualizer;
      return visualizer;
    });
    context.ui.setStatus("pi-live-codex", "connecting");
    this.#animation = setInterval(() => {
      this.#visualizer?.advanceFrame();
    }, 80);

    try {
      await session.start();
      if (this.#session === session) {
        context.ui.setStatus("pi-live-codex", "live");
      }
    } catch {
      // LiveSession reports the actionable error through onTerminal.
    }
  }

  handleAgentMessage(message: AgentMessage): void {
    this.#session?.handleAgentMessage(message);
  }

  handleAgentSettled(): void {
    this.#session?.handleAgentSettled();
  }

  async stop(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    await session.stop();
    this.#finish(session);
  }

  #finish(session: LiveSession, error?: Error): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    clearInterval(this.#animation);
    this.#animation = undefined;
    this.#visualizer = undefined;

    const context = this.#context;
    this.#context = undefined;
    if (!context) return;
    context.ui.setStatus("pi-live-codex", undefined);
    context.ui.setEditorComponent(this.#previousEditor);
    context.ui.setEditorText(this.#previousText);
    this.#previousEditor = undefined;
    this.#previousText = "";
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

  pi.on("session_shutdown", async () => {
    await runtime.stop();
  });
}
