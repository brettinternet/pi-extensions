import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const REFRESH_MS = 2_000;
const BASELINE_ENTRY = "pi-footer-git-baseline-v1";
const UNBORN_HEAD = "(unborn)";

type FooterTheme = ExtensionContext["ui"]["theme"];
type ThemeColor = Parameters<FooterTheme["fg"]>[0];

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

export interface GitState {
  available: boolean;
  head?: string;
  added: number;
  removed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  sessionCommits?: number;
  historyChanged?: boolean;
}

interface FooterSnapshot {
  cwd: string;
  home?: string;
  branch: string | null;
  title?: string;
  model?: { id: string; provider: string; reasoning?: boolean };
  thinkingLevel?: string;
  context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  usage: UsageTotals;
  git: GitState;
}

interface StyledPart {
  text: string;
  priority: number;
}

function formatCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

export function sanitizeFooterText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function execSucceeded(result: { code: number; killed?: boolean }): boolean {
  return result.code === 0 && result.killed !== true;
}

export function formatFooterCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome = relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function collectUsage(entries: readonly unknown[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as {
      type?: string;
      message?: { role?: string; usage?: Record<string, unknown> };
      usage?: Record<string, unknown>;
    };
    const usage = entry.type === "message" ? entry.message?.usage : entry.usage;
    if (!usage) continue;
    const shouldCount = (entry.type === "message" &&
      (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) ||
      entry.type === "branch_summary" || entry.type === "compaction";
    if (!shouldCount) continue;

    const input = Number(usage.input) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    const cacheWrite = Number(usage.cacheWrite) || 0;
    totals.input += input;
    totals.output += Number(usage.output) || 0;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    const cost = usage.cost;
    if (cost && typeof cost === "object") totals.cost += Number((cost as { total?: unknown }).total) || 0;
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const prompt = input + cacheRead + cacheWrite;
      totals.latestCacheHitRate = prompt > 0 ? cacheRead / prompt * 100 : undefined;
    }
  }
  return totals;
}

export function parseGitState(
  statusOutput: string,
  diffOutput: string,
  head: string | undefined,
  sessionCommits?: number,
  historyChanged = false,
): GitState {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of statusOutput.split("\n")) {
    if (line.length < 2) continue;
    const index = line[0]!;
    const worktree = line[1]!;
    if (index === "?" && worktree === "?") untracked += 1;
    else {
      if (index !== " ") staged += 1;
      if (worktree !== " ") unstaged += 1;
    }
  }

  let added = 0;
  let removed = 0;
  for (const line of diffOutput.split("\n")) {
    const [addedText, removedText] = line.split("\t");
    if (/^\d+$/.test(addedText ?? "")) added += Number(addedText);
    if (/^\d+$/.test(removedText ?? "")) removed += Number(removedText);
  }
  return { available: true, head, added, removed, staged, unstaged, untracked, sessionCommits, historyChanged };
}

function color(theme: FooterTheme, name: ThemeColor, text: string): string {
  return theme.fg(name, text);
}

function joinParts(parts: StyledPart[]): string {
  return parts.map((part) => part.text).join("  ");
}

function fitRightParts(parts: StyledPart[], available: number): string {
  let visible = [...parts];
  while (visible.length > 1 && visibleWidth(joinParts(visible)) > available) {
    const removable = visible.reduce((lowest, part, index) =>
      part.priority < visible[lowest]!.priority ? index : lowest, 0);
    visible.splice(removable, 1);
  }
  return truncateToWidth(joinParts(visible), Math.max(0, available), "");
}

function align(left: string, right: string, width: number): string {
  const gap = right ? 2 : 0;
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - gap);
  const fittedLeft = truncateToWidth(left, leftWidth, "…");
  const padding = " ".repeat(Math.max(gap, width - visibleWidth(fittedLeft) - rightWidth));
  return truncateToWidth(fittedLeft + (right ? padding + right : ""), width, "");
}

function contextGauge(percent: number | null, theme: FooterTheme): string {
  const cells = 10;
  const filled = percent === null ? 0 : Math.max(0, Math.min(cells, Math.round(percent / 100 * cells)));
  const severity: ThemeColor = percent !== null && percent >= 90
    ? "error"
    : percent !== null && percent >= 70 ? "warning" : "accent";
  return color(theme, severity, "█".repeat(filled)) + color(theme, "dim", "░".repeat(cells - filled));
}

function gitParts(git: GitState, theme: FooterTheme): string[] {
  if (!git.available) return [];
  const parts: string[] = [];
  if (git.added > 0) parts.push(color(theme, "success", `+${git.added}`));
  if (git.removed > 0) parts.push(color(theme, "error", `-${git.removed}`));
  if (git.staged > 0) parts.push(color(theme, "success", `●${git.staged}`));
  if (git.unstaged > 0) parts.push(color(theme, "warning", `✚${git.unstaged}`));
  if (git.untracked > 0) parts.push(color(theme, "muted", `…${git.untracked}`));
  if (git.sessionCommits && git.sessionCommits > 0) {
    parts.push(color(theme, "success", ` +${git.sessionCommits}`));
  } else if (git.historyChanged) {
    parts.push(color(theme, "warning", " ↻"));
  }
  return parts;
}

export function renderFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme): string[] {
  const locationText = sanitizeFooterText(formatFooterCwd(snapshot.cwd, snapshot.home));
  const location = color(theme, "dim", `󰉋 ${locationText}`);
  const branchText = snapshot.branch ? sanitizeFooterText(snapshot.branch) : "";
  const branch = branchText ? color(theme, "accent", ` ${branchText}`) : "";
  const changes = gitParts(snapshot.git, theme).join(" ");
  const leftTop = [location, branch, changes].filter(Boolean).join("  ");
  const title = snapshot.title ? sanitizeFooterText(snapshot.title) : "";
  const rightTop = title ? color(theme, "accent", title) : "";

  const context = snapshot.context;
  const contextPercent = context?.percent ?? null;
  const contextColor: ThemeColor = contextPercent !== null && contextPercent >= 90
    ? "error"
    : contextPercent !== null && contextPercent >= 70 ? "warning" : "text";
  const contextText = context
    ? `${context.tokens === null ? "?" : formatCount(context.tokens)}/${formatCount(context.contextWindow)} ${contextPercent === null ? "?" : `${contextPercent.toFixed(0)}%`}`
    : "context unavailable";
  const leftBottom = `${color(theme, "accent", "󰘦")} ${contextGauge(contextPercent, theme)} ${color(theme, contextColor, contextText)}`;

  const usage = snapshot.usage;
  const rightParts: StyledPart[] = [
    { text: color(theme, "muted", `󰍉 ${formatCount(usage.input)}`), priority: 9 },
    { text: color(theme, "muted", `󰍌 ${formatCount(usage.output)}`), priority: 9 },
    ...(usage.cacheRead > 0
      ? [{ text: color(theme, "dim", `󰒍 R${formatCount(usage.cacheRead)}`), priority: 3 }]
      : []),
    ...(usage.cacheWrite > 0
      ? [{ text: color(theme, "dim", `W${formatCount(usage.cacheWrite)}`), priority: 1 }]
      : []),
    ...(usage.latestCacheHitRate !== undefined
      ? [{ text: color(theme, "dim", `${usage.latestCacheHitRate.toFixed(0)}% hit`), priority: 2 }]
      : []),
    ...(usage.cost > 0
      ? [{ text: color(theme, "success", `󰆼 $${usage.cost.toFixed(3)}`), priority: 8 }]
      : []),
    ...(snapshot.model
      ? [{
          text: color(
            theme,
            "dim",
            `󰚩 ${sanitizeFooterText(snapshot.model.provider)}/${sanitizeFooterText(snapshot.model.id)}`,
          ),
          priority: 7,
        }]
      : []),
    ...(snapshot.model?.reasoning
      ? [{
          text: color(
            theme,
            (`thinking${(snapshot.thinkingLevel ?? "off").replace(/^./, (letter) => letter.toUpperCase())}` as ThemeColor),
            ` ${sanitizeFooterText(snapshot.thinkingLevel ?? "off")}`,
          ),
          priority: 6,
        }]
      : []),
  ];
  const rightBottom = fitRightParts(rightParts, Math.max(0, width - visibleWidth(leftBottom) - 2));

  return [align(leftTop, rightTop, width), align(leftBottom, rightBottom, width)];
}

function baselineFromSession(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== BASELINE_ENTRY) continue;
    const data = entry.data as { cwd?: unknown; head?: unknown } | undefined;
    if (data?.cwd === ctx.cwd && typeof data.head === "string") return data.head;
  }
  return undefined;
}

export default function footerExtension(pi: ExtensionAPI): void {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshController: AbortController | undefined;
  let lifecycle = 0;
  let refreshingLifecycle: number | undefined;
  let baselineHead: string | undefined;
  let git: GitState = { available: false, added: 0, removed: 0, staged: 0, unstaged: 0, untracked: 0 };
  let requestRender: (() => void) | undefined;

  function resetGit(): void {
    git = { available: false, added: 0, removed: 0, staged: 0, unstaged: 0, untracked: 0 };
  }

  async function refreshGit(
    ctx: ExtensionContext,
    expectedLifecycle: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (refreshingLifecycle === expectedLifecycle) return;
    refreshingLifecycle = expectedLifecycle;
    try {
      const [headResult, statusResult] = await Promise.all([
        pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--verify", "HEAD"], { timeout: 1_500, signal }),
        pi.exec("git", ["-C", ctx.cwd, "status", "--porcelain=v1", "--untracked-files=normal"], { timeout: 1_500, signal }),
      ]);
      if (signal.aborted || expectedLifecycle !== lifecycle) return;
      if (!execSucceeded(statusResult)) {
        resetGit();
        return;
      }

      const hasHead = execSucceeded(headResult) && headResult.stdout.trim().length > 0;
      const head = hasHead ? headResult.stdout.trim() : undefined;
      const diffResults = hasHead
        ? [await pi.exec("git", ["-C", ctx.cwd, "diff", "--numstat", "HEAD", "--"], { timeout: 1_500, signal })]
        : await Promise.all([
            pi.exec("git", ["-C", ctx.cwd, "diff", "--numstat", "--cached", "--"], { timeout: 1_500, signal }),
            pi.exec("git", ["-C", ctx.cwd, "diff", "--numstat", "--"], { timeout: 1_500, signal }),
          ]);
      if (signal.aborted || expectedLifecycle !== lifecycle) return;
      if (diffResults.some((result) => !execSucceeded(result))) {
        resetGit();
        return;
      }

      if (!baselineHead) {
        baselineHead = head ?? UNBORN_HEAD;
        pi.appendEntry(BASELINE_ENTRY, { cwd: ctx.cwd, head: baselineHead });
      }

      let sessionCommits: number | undefined;
      let historyChanged = false;
      if (head && baselineHead !== head) {
        const range = baselineHead === UNBORN_HEAD ? head : `${baselineHead}..${head}`;
        const countResult = await pi.exec("git", ["-C", ctx.cwd, "rev-list", "--count", range], { timeout: 1_500, signal });
        if (signal.aborted || expectedLifecycle !== lifecycle) return;
        if (!execSucceeded(countResult)) {
          resetGit();
          return;
        }
        sessionCommits = Number.parseInt(countResult.stdout.trim(), 10) || 0;
        historyChanged = sessionCommits === 0;
      }
      git = parseGitState(
        statusResult.stdout,
        diffResults.map((result) => result.stdout).join("\n"),
        head,
        sessionCommits,
        historyChanged,
      );
    } finally {
      if (refreshingLifecycle === expectedLifecycle) refreshingLifecycle = undefined;
      if (expectedLifecycle === lifecycle) requestRender?.();
    }
  }

  function queueRefresh(ctx: ExtensionContext, expectedLifecycle: number, signal: AbortSignal): void {
    void refreshGit(ctx, expectedLifecycle, signal).catch(() => {
      if (expectedLifecycle === lifecycle && !signal.aborted) {
        resetGit();
        requestRender?.();
      }
    });
  }

  function stopRefresh(clearRenderer = true): void {
    lifecycle += 1;
    refreshController?.abort();
    refreshController = undefined;
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    if (clearRenderer) requestRender = undefined;
  }

  function startRefresh(ctx: ExtensionContext): void {
    stopRefresh(false);
    baselineHead = baselineFromSession(ctx);
    resetGit();
    const expectedLifecycle = lifecycle;
    const controller = new AbortController();
    refreshController = controller;
    queueRefresh(ctx, expectedLifecycle, controller.signal);
    refreshTimer = setInterval(
      () => queueRefresh(ctx, expectedLifecycle, controller.signal),
      REFRESH_MS,
    );
    refreshTimer.unref?.();
  }

  pi.on("session_start", (_event, ctx) => {
    stopRefresh();
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(() => {
        if (refreshController) queueRefresh(ctx, lifecycle, refreshController.signal);
        tui.requestRender();
      });
      startRefresh(ctx);

      return {
        render(width: number): string[] {
          const lines = renderFooter({
            cwd: ctx.cwd,
            home: process.env.HOME || process.env.USERPROFILE,
            branch: footerData.getGitBranch(),
            title: pi.getSessionName(),
            model: ctx.model,
            thinkingLevel: ctx.thinkingLevel,
            context: ctx.getContextUsage(),
            usage: collectUsage(ctx.sessionManager.getEntries()),
            git,
          }, width, theme);
          const statuses = [...footerData.getExtensionStatuses().entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, text]) => sanitizeFooterText(text))
            .filter(Boolean);
          if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, "…"));
          return lines;
        },
        invalidate() {},
        dispose() {
          unsubscribeBranch();
          stopRefresh();
        },
      };
    });
  });

  pi.on("session_tree", (_event, ctx) => {
    if (ctx.mode === "tui" && requestRender) startRefresh(ctx);
  });

  pi.on("session_shutdown", () => stopRefresh());
}
