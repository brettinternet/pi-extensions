import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CheckActivity, ProgressSnapshot } from "./state.ts";

const MAX_VISIBLE_PATHS = 3;

export function formatRuntime(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatCheck(check: CheckActivity, theme: Theme): string {
  return check.outcome === "passed"
    ? theme.fg("success", `✓ ${check.label}`)
    : theme.fg("error", `✗ ${check.label}`);
}

function toolSummary(snapshot: ProgressSnapshot, theme: Theme): string {
  const [current, ...rest] = snapshot.tools;
  if (current) {
    const label = current.check?.label ?? current.label;
    const suffix = rest.length ? theme.fg("dim", ` +${rest.length}`) : "";
    return `${theme.fg("accent", "●")} ${theme.fg("text", label)}${suffix}`;
  }
  return snapshot.agentActive
    ? `${theme.fg("accent", "●")} ${theme.fg("dim", "thinking")}`
    : theme.fg("success", "✓ settled");
}

function inferredSummary(snapshot: ProgressSnapshot, theme: Theme): string | undefined {
  const semantic = snapshot.semantic;
  if (!semantic) return undefined;

  const label = snapshot.agentActive && semantic.current
    ? `current: ${semantic.current}`
    : semantic.blocked[0]
      ? `blocked: ${semantic.blocked[0]}`
      : semantic.completed[0]
        ? `completed: ${semantic.completed[0]}`
        : semantic.current
          ? `current: ${semantic.current}`
          : semantic.phase;
  return label ? theme.fg("dim", `${label} inferred`) : undefined;
}

export function renderProgress(
  snapshot: ProgressSnapshot,
  theme: Theme,
  width: number,
  runtime?: string,
): string[] {
  const hasObservedFacts =
    snapshot.runStarted ||
    snapshot.agentActive ||
    snapshot.tools.length > 0 ||
    snapshot.checks.length > 0 ||
    snapshot.touchedPaths.length > 0;
  if ((!hasObservedFacts && !snapshot.semantic && !runtime) || width < 8) return [];

  const separator = theme.fg("dim", " · ");
  const heading = theme.fg("dim", runtime ? `progress ${runtime}` : "progress");
  if (!hasObservedFacts && !snapshot.semantic) {
    return [truncateToWidth(heading, width)];
  }
  if (!hasObservedFacts && snapshot.semantic) {
    const inferred = inferredSummary(snapshot, theme);
    return inferred
      ? [truncateToWidth([
        heading,
        inferred,
      ].join(separator), width)]
      : [];
  }
  const observedParts = [
    heading,
    toolSummary(snapshot, theme),
    ...snapshot.checks.map((check) => formatCheck(check, theme)),
  ];
  const inferred = inferredSummary(snapshot, theme);
  const withInference = inferred
    ? [observedParts[0], inferred, ...observedParts.slice(1)].join(separator)
    : "";
  const hasDetailedObservedFacts =
    snapshot.tools.length > 0 ||
    snapshot.checks.length > 0 ||
    snapshot.touchedPaths.length > 0;
  const inferenceOnly = inferred
    ? [observedParts[0], inferred].join(separator)
    : "";
  const activity = inferred &&
      (visibleWidth(withInference) <= width || !hasDetailedObservedFacts)
    ? (visibleWidth(withInference) <= width ? withInference : inferenceOnly)
    : observedParts.join(separator);
  const lines = [truncateToWidth(activity, width)];

  if (snapshot.touchedPaths.length > 0) {
    const visible = snapshot.touchedPaths.slice(-MAX_VISIBLE_PATHS);
    const hidden = snapshot.touchedPaths.length - visible.length;
    const paths = visible
      .map((path) => theme.fg("muted", path))
      .join(theme.fg("dim", " · "));
    const overflow = hidden > 0 ? theme.fg("dim", ` +${hidden}`) : "";
    lines.push(
      truncateToWidth(
        `${theme.fg("dim", "touched")} ${paths}${overflow}`,
        width,
      ),
    );
  }

  return lines;
}
