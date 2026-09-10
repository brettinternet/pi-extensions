import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AgentState = "working" | "blocked" | "idle";

type StateReport = {
  state: AgentState;
  message?: string;
  seq: number;
};

type HerdrEnvironment = Record<string, string | undefined>;

type StateBridgeOptions = {
  env?: HerdrEnvironment;
  now?: () => number;
  sendRequest?: (request: Record<string, unknown>) => Promise<void>;
};

const SOURCE = "herdr:pi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeValue(value: unknown): boolean | undefined {
  if (!isRecord(value) || typeof value.active !== "boolean") return undefined;
  return value.active;
}

function labelValue(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.label !== "string" || !value.label.trim()) return undefined;
  return value.label;
}

function isRootBlockedEvent(value: unknown): boolean {
  return isRecord(value) && value.scope === "root";
}

function sessionReference(ctx: ExtensionContext): Record<string, string> {
  try {
    const path = ctx.sessionManager.getSessionFile();
    if (typeof path === "string" && path.startsWith("/")) return { agent_session_path: path };
  } catch {}
  try {
    const id = ctx.sessionManager.getSessionId();
    if (typeof id === "string" && id) return { agent_session_id: id };
  } catch {}
  return {};
}

function sendRequestAttempt(
  request: Record<string, unknown>,
  env: HerdrEnvironment,
  timeoutMs: number,
): Promise<boolean> {
  const socketPath = env.HERDR_SOCKET_PATH;
  if (env.HERDR_ENV !== "1" || !socketPath || !env.HERDR_PANE_ID) return Promise.resolve(true);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const socket = net.createConnection(endpoint);
    const finish = (delivered: boolean): void => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: Record<string, unknown>, env: HerdrEnvironment): Promise<void> {
  if (await sendRequestAttempt(request, env, 500)) return;
  await sendRequestAttempt(request, env, 1500);
}

export function registerHerdrAgentState(
  pi: Pick<ExtensionAPI, "on" | "events">,
  options: StateBridgeOptions = {},
): { flush: () => Promise<void> } {
  const env = options.env ?? process.env;
  const paneId = env.HERDR_PANE_ID;
  const enabled = env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!paneId;
  if (!enabled) return { flush: async () => {} };

  const now = options.now ?? Date.now;
  const send = options.sendRequest ?? ((request) => sendRequest(request, env));
  let rootSession = false;
  let agentActive = false;
  let busyCount = 0;
  let busyLabel: string | undefined;
  let blockedCount = 0;
  let blockedLabel: string | undefined;
  let sessionRef: Record<string, string> = {};
  let reportSeq = 0;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let pending: StateReport | undefined;
  let draining: Promise<void> | undefined;

  const nextSeq = (): number => {
    reportSeq = Math.max(reportSeq + 1, now() * 1000);
    return reportSeq;
  };

  const desiredState = (): { state: AgentState; message?: string } => {
    if (blockedCount > 0) return { state: "blocked", message: blockedLabel };
    if (busyCount > 0) return { state: "working", message: busyLabel };
    if (agentActive) return { state: "working" };
    return { state: "idle" };
  };

  const drain = async (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      while (pending) {
        const report = pending;
        pending = undefined;
        await send({
          id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          method: "pane.report_agent",
          params: {
            pane_id: paneId,
            source: SOURCE,
            agent: "pi",
            state: report.state,
            message: report.message,
            seq: report.seq,
            ...sessionRef,
          },
        });
      }
    })().finally(() => {
      draining = undefined;
      if (pending) void drain();
    });
    return draining;
  };

  const publish = (force = false): void => {
    if (!rootSession) return;
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    pending = { ...next, seq: nextSeq() };
    void drain();
  };

  const updateSession = (ctx: ExtensionContext): void => {
    sessionRef = sessionReference(ctx);
  };

  const reportSession = async (reason?: string): Promise<void> => {
    if (Object.keys(sessionRef).length === 0) return;
    await send({
      id: `${SOURCE}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId,
        source: SOURCE,
        agent: "pi",
        seq: nextSeq(),
        session_start_source: reason,
        ...sessionRef,
      },
    });
  };

  pi.events.on("herdr:busy", (value) => {
    const active = activeValue(value);
    if (active === undefined) return;
    if (active) {
      busyCount += 1;
      busyLabel = labelValue(value) ?? busyLabel;
    } else {
      busyCount = Math.max(0, busyCount - 1);
      if (busyCount === 0) busyLabel = undefined;
    }
    publish();
  });

  const updateBlocked = (active: boolean, label?: string): void => {
    if (active) {
      blockedCount += 1;
      blockedLabel = label ?? blockedLabel;
    } else {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedLabel = undefined;
    }
    publish();
  };

  pi.events.on("herdr:blocked", (value) => {
    if (!isRootBlockedEvent(value)) return;
    const active = activeValue(value);
    if (active === undefined) return;
    updateBlocked(active, labelValue(value));
  });

  pi.events.on("rpiv:ask-user:blocked", (value) => {
    const active = activeValue(value);
    if (active === undefined) return;
    updateBlocked(active, active ? "Waiting for user" : undefined);
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    // `custom` is also used for live inspectors that do not wait for user input.
    if (event.kind === "custom") return;
    updateSession(ctx);
    updateBlocked(true, event.title?.trim() || "Waiting for user");
  });

  pi.on("ui_prompt_end", (event, ctx) => {
    if (event.kind === "custom") return;
    updateSession(ctx);
    updateBlocked(false);
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    rootSession = true;
    agentActive = ctx.isIdle() === false;
    updateSession(ctx);
    await reportSession(event.reason);
    publish(true);
  });

  const markWorking = (_event: unknown, ctx: ExtensionContext): void => {
    if (!rootSession) return;
    updateSession(ctx);
    agentActive = true;
    publish();
  };
  pi.on("before_agent_start", markWorking);
  pi.on("agent_start", markWorking);

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx.isIdle() !== true) return;
    updateSession(ctx);
    agentActive = false;
    publish();
  });

  pi.on("session_shutdown", () => {
    rootSession = false;
    pending = undefined;
    busyCount = 0;
    blockedCount = 0;
    agentActive = false;
  });

  return { flush: async () => { while (draining || pending) await (draining ?? drain()); } };
}

export default function herdrAgentStateExtension(pi: ExtensionAPI): void {
  registerHerdrAgentState(pi);
}
