import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// This module intentionally owns a local copy of the wire contract. Producers and
// consumers may be installed as unrelated packages and communicate only via pi.events.
export const CONFIRMATION_REQUESTED_EVENT = "pi:confirmation:v1:requested";
export const CONFIRMATION_ACKNOWLEDGED_PREFIX = "pi:confirmation:v1:acknowledged:";
export const CONFIRMATION_RESOLVED_PREFIX = "pi:confirmation:v1:resolved:";
export const CONFIRMATION_CANCELLED_EVENT = "pi:confirmation:v1:cancelled";

export const MAX_PENDING_CONFIRMATIONS = 32;
export const MAX_CONFIRMATIONS_PER_SESSION = 1_024;
export const MAX_CONFIRMATION_TITLE_CHARS = 160;
export const MAX_CONFIRMATION_SUMMARY_CHARS = 4_000;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_PROVIDER_CHARS = 80;
const MAX_RISK_CATEGORY_CHARS = 80;
const MAX_EXPIRY_WINDOW_MS = 5 * 60_000;

export interface ConfirmationRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  sessionFile?: string;
  provider: string;
  operationId: string;
  riskCategory: string;
  title: string;
  summary: string;
  expiresAt: number;
}

export type ConfirmationDecision = "approved" | "denied";

export interface ConfirmationResolution {
  version: 1;
  requestId: string;
  sessionId: string;
  sessionFile?: string;
  provider: string;
  operationId: string;
  decision: ConfirmationDecision;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function validIdentifier(value: unknown): value is string {
  return boundedText(value, MAX_IDENTIFIER_CHARS) && /^[A-Za-z0-9:._-]+$/.test(value);
}

function matchesSession(value: Record<string, unknown>, context: ExtensionContext): boolean {
  if (value.sessionId !== context.sessionManager.getSessionId()) return false;
  const sessionFile = value.sessionFile;
  return sessionFile === undefined ||
    typeof sessionFile === "string" && sessionFile === context.sessionManager.getSessionFile();
}

export function parseConfirmationRequest(
  value: unknown,
  context: ExtensionContext,
  now = Date.now(),
): ConfirmationRequest | undefined {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1 || !matchesSession(candidate, context) ||
    !validIdentifier(candidate.requestId) || !boundedText(candidate.provider, MAX_PROVIDER_CHARS) ||
    !validIdentifier(candidate.operationId) ||
    !boundedText(candidate.riskCategory, MAX_RISK_CATEGORY_CHARS) ||
    !boundedText(candidate.title, MAX_CONFIRMATION_TITLE_CHARS) ||
    !boundedText(candidate.summary, MAX_CONFIRMATION_SUMMARY_CHARS) ||
    typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt <= now || candidate.expiresAt > now + MAX_EXPIRY_WINDOW_MS) return undefined;
  return {
    version: 1,
    requestId: candidate.requestId,
    sessionId: candidate.sessionId as string,
    ...(typeof candidate.sessionFile === "string" ? { sessionFile: candidate.sessionFile } : {}),
    provider: candidate.provider,
    operationId: candidate.operationId,
    riskCategory: candidate.riskCategory,
    title: candidate.title,
    summary: candidate.summary,
    expiresAt: candidate.expiresAt,
  };
}

export function confirmationReply(
  request: ConfirmationRequest,
  decision?: ConfirmationDecision,
): ConfirmationResolution | Omit<ConfirmationResolution, "decision"> {
  return {
    version: 1,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ...(request.sessionFile ? { sessionFile: request.sessionFile } : {}),
    provider: request.provider,
    operationId: request.operationId,
    ...(decision ? { decision } : {}),
  };
}

export function sameConfirmation(value: unknown, request: ConfirmationRequest): boolean {
  const candidate = record(value);
  return !!candidate && candidate.version === 1 &&
    candidate.requestId === request.requestId &&
    candidate.sessionId === request.sessionId &&
    candidate.sessionFile === request.sessionFile &&
    candidate.provider === request.provider &&
    candidate.operationId === request.operationId;
}
