import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CheckActivity, ProgressSnapshot } from "./state.ts";

const MAX_VISIBLE_PATHS = 3;

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

export function renderProgress(
  snapshot: ProgressSnapshot,
  theme: Theme,
  width: number,
): string[] {
  const hasObservedFacts =
    snapshot.runStarted ||
    snapshot.agentActive ||
    snapshot.tools.length > 0 ||
    snapshot.checks.length > 0 ||
    snapshot.touchedPaths.length > 0;
  if ((!hasObservedFacts && !snapshot.semantic) || width < 8) return [];

  const separator = theme.fg("dim", " · ");
  if (!hasObservedFacts && snapshot.semantic) {
    return [truncateToWidth([
      theme.fg("dim", "progress"),
      theme.fg("dim", `${snapshot.semantic.phase} inferred`),
    ].join(separator), width)];
  }
  const observedParts = [
    theme.fg("dim", "progress"),
    toolSummary(snapshot, theme),
    ...snapshot.checks.map((check) => formatCheck(check, theme)),
  ];
  const inferred = snapshot.semantic
    ? theme.fg("dim", `${snapshot.semantic.phase} inferred`)
    : undefined;
  const withInference = inferred
    ? [observedParts[0], inferred, ...observedParts.slice(1)].join(separator)
    : "";
  const activity = inferred && visibleWidth(withInference) <= width
    ? withInference
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
