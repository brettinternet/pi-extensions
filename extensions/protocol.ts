// Adapted from Oh My Pi's MIT-licensed live protocol implementation.
import { isObject } from "./type-guards.ts";
export const LIVE_MODEL = "gpt-live-1-codex" as const;
export const CONTEXT_CHUNK_BYTES = 500;

export type LiveContextChannel = "speakable" | "commentary";
export type LiveInputTextContent = { type: "input_text"; text: string };

export type LiveSessionPayload = {
  model: typeof LIVE_MODEL;
  instructions: string;
  audio: { output: { voice: string } };
  delegation: { type: "client" };
};

export type LiveClientMessage =
  | {
      type: "delegation.context.append";
      delegation_item_id: string;
      channel?: LiveContextChannel;
      content: LiveInputTextContent[];
    }
  | {
      type: "session.context.append";
      channel?: LiveContextChannel;
      content: LiveInputTextContent[];
    }
  | { type: "session.close" };

export type LiveServerEvent =
  | {
      type: "session.started" | "session.updated";
      session: { id: string; instructions?: string };
    }
  | { type: "output_audio.delta"; audio: string }
  | {
      type: "input_transcript.added" | "output_transcript.added";
      item: { text: string };
    }
  | {
      type: "turn.done";
      turn: { role: "user" | "assistant"; transcript: string };
    }
  | {
      type: "delegation.created";
      item: {
        type: "delegation";
        target: "client";
        id: string;
        content: LiveInputTextContent[];
      };
    }
  | { type: "error"; message: string }
  | { type: "unknown"; wireType: string };

type UnknownRecord = Record<string, unknown>;


function parsePayload(payload: unknown): UnknownRecord | null {
  let parsed = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return isObject(parsed) ? parsed : null;
}

function parseSessionEvent(
  type: "session.started" | "session.updated",
  payload: UnknownRecord,
): LiveServerEvent | null {
  const session = payload.session;
  if (!isObject(session) || typeof session.id !== "string") return null;
  return {
    type,
    session: {
      id: session.id,
      ...(typeof session.instructions === "string"
        ? { instructions: session.instructions }
        : {}),
    },
  };
}

function parseTranscriptEvent(
  type: "input_transcript.added" | "output_transcript.added",
  payload: UnknownRecord,
): LiveServerEvent | null {
  const item = payload.item;
  if (!isObject(item) || typeof item.text !== "string") return null;
  return { type, item: { text: item.text } };
}

function parseTurnDone(payload: UnknownRecord): LiveServerEvent | null {
  const turn = payload.turn;
  if (!isObject(turn) || (turn.role !== "user" && turn.role !== "assistant")) {
    return null;
  }
  if (typeof turn.transcript !== "string") return null;
  return {
    type: "turn.done",
    turn: { role: turn.role, transcript: turn.transcript },
  };
}

function parseDelegation(payload: UnknownRecord): LiveServerEvent | null {
  const item = payload.item;
  if (
    !isObject(item) ||
    item.type !== "delegation" ||
    item.target !== "client" ||
    typeof item.id !== "string" ||
    !Array.isArray(item.content)
  ) {
    return null;
  }

  const content: LiveInputTextContent[] = [];
  for (const candidate of item.content) {
    if (
      isObject(candidate) &&
      candidate.type === "input_text" &&
      typeof candidate.text === "string"
    ) {
      content.push({ type: "input_text", text: candidate.text });
    }
  }

  return {
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: item.id,
      content,
    },
  };
}

function parseError(payload: UnknownRecord): LiveServerEvent | null {
  if (typeof payload.message === "string") {
    return { type: "error", message: payload.message };
  }
  const error = payload.error;
  if (isObject(error) && typeof error.message === "string") {
    return { type: "error", message: error.message };
  }
  if (error === undefined) return null;
  try {
    return { type: "error", message: JSON.stringify(error) };
  } catch {
    return { type: "error", message: String(error) };
  }
}

export function parseLiveServerEvent(payload: unknown): LiveServerEvent | null {
  const parsed = parsePayload(payload);
  if (!parsed || typeof parsed.type !== "string") return null;

  switch (parsed.type) {
    case "session.started":
    case "session.updated":
      return parseSessionEvent(parsed.type, parsed);
    case "output_audio.delta":
      return typeof parsed.audio === "string"
        ? { type: parsed.type, audio: parsed.audio }
        : null;
    case "input_transcript.added":
    case "output_transcript.added":
      return parseTranscriptEvent(parsed.type, parsed);
    case "turn.done":
      return parseTurnDone(parsed);
    case "delegation.created":
      return parseDelegation(parsed);
    case "error":
      return parseError(parsed);
    default:
      return { type: "unknown", wireType: parsed.type };
  }
}

export function buildLiveSessionPayload(
  instructions: string,
  voice: string,
): LiveSessionPayload {
  return {
    model: LIVE_MODEL,
    instructions,
    audio: { output: { voice } },
    delegation: { type: "client" },
  };
}

export function buildSessionContextAppend(
  text: string,
  channel?: LiveContextChannel,
): LiveClientMessage {
  return {
    type: "session.context.append",
    ...(channel ? { channel } : {}),
    content: [{ type: "input_text", text }],
  };
}

export function buildDelegationContextAppend(
  delegationId: string,
  text: string,
  channel?: LiveContextChannel,
): LiveClientMessage {
  return {
    type: "delegation.context.append",
    delegation_item_id: delegationId,
    ...(channel ? { channel } : {}),
    content: [{ type: "input_text", text }],
  };
}

export function buildSessionClose(): LiveClientMessage {
  return { type: "session.close" };
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function chunkLiveContext(text: string): string[] {
  if (text.length === 0) return [""];

  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const characterBytes = utf8ByteLength(codePoint);
    if (bytes + characterBytes > CONTEXT_CHUNK_BYTES) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += characterBytes;
    index += characterLength;
  }
  chunks.push(text.slice(start));
  return chunks;
}
