import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { loadPrompts, type Prompt } from "./history.ts";
import { searchPrompts, type SearchResult } from "./search.ts";

const VISIBLE = 10;

function highlight(text: string, ranges: Array<[number, number]>, theme: Theme): string {
  if (!ranges.length) return text;
  let result = "";
  let offset = 0;
  let current = "";
  let active = false;
  for (const character of text) {
    const matched = ranges.some(([start, end]) => start < offset + character.length && end > offset);
    if (matched !== active) {
      result += active ? theme.fg("warning", current) : current;
      current = "";
      active = matched;
    }
    current += character;
    offset += character.length;
  }
  return result + (active ? theme.fg("warning", current) : current);
}

function age(timestamp: number): string {
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export class HistoryPicker {
  focused = true;
  private readonly input = new Input({ prompt: "> " });
  private scope: "project" | "global" = "project";
  private selected = 0;
  private offset = 0;
  private loading = false;
  private disposed = false;
  private globalLoaded = false;
  private searchCache?: { prompts: readonly Prompt[]; scope: "project" | "global"; query: string; results: SearchResult[] };

  constructor(
    private prompts: readonly Prompt[],
    private readonly cwd: string,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly done: (result: string | undefined) => void,
    initialQuery = "",
    initialScope: "project" | "global" = "project",
    private readonly loadGlobal?: () => Promise<Prompt[]>,
  ) {
    this.scope = initialScope;
    this.globalLoaded = initialScope === "global";
    this.input.setValue(initialQuery);
  }

  private results(): SearchResult[] {
    const query = this.input.getValue();
    const previous = this.searchCache;
    if (previous && previous.prompts === this.prompts && previous.scope === this.scope && previous.query === query) return previous.results;
    const results = searchPrompts(this.prompts, this.cwd, this.scope, query);
    this.searchCache = { prompts: this.prompts, scope: this.scope, query, results };
    return results;
  }

  private visibleCount(): number {
    return this.scope === "global" ? 5 : VISIBLE;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+r")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.scope = this.scope === "project" ? "global" : "project";
      this.selected = 0;
      this.offset = 0;
      if (this.scope === "global" && !this.globalLoaded && !this.loading && this.loadGlobal) {
        this.loading = true;
        void this.loadGlobal().then((prompts) => {
          if (this.disposed) return;
          this.prompts = prompts;
          this.globalLoaded = true;
          this.loading = false;
          this.tui.requestRender();
        }).catch(() => {
          if (this.disposed) return;
          this.loading = false;
          this.tui.requestRender();
        });
      }
    } else if ((["up", "down", "ctrl+p", "ctrl+n", "ctrl+k", "ctrl+j", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))) {
      const delta = matchesKey(data, "up") || matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+k")
        ? -1 : matchesKey(data, "down") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+j")
          ? 1 : matchesKey(data, "pageUp") ? -this.visibleCount() : this.visibleCount();
      this.selected = Math.max(0, Math.min(this.results().length - 1, this.selected + delta));
      this.offset = Math.max(0, Math.min(this.offset, this.selected), this.selected - this.visibleCount() + 1);
    } else if (matchesKey(data, "enter")) {
      if (this.loading && this.scope === "global") return;
      this.done(this.results()[this.selected]?.prompt.text);
      return;
    } else {
      this.input.handleInput(data);
      this.selected = 0;
      this.offset = 0;
    }
    this.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) => border("│") + truncateToWidth(text, inner, "…", true) + border("│");
    const results = this.results();
    this.input.focused = this.focused;
    const title = truncateToWidth(` History · ${this.scope === "project" ? "Project" : "Global"} `, inner);
    const lines = [border("╭") + this.theme.fg("accent", title) + border("─".repeat(Math.max(0, inner - title.length)) + "╮")];
    lines.push(row(""));
    lines.push(row(` ${this.input.render(Math.max(1, inner - 2))[0] ?? ""}`));
    lines.push(row(""));
    if (this.loading && this.scope === "global") lines.push(row(this.theme.fg("muted", " Loading global history…")));
    else if (results.length === 0) lines.push(row(this.theme.fg("muted", " No matching prompts")));
    for (let i = this.offset; !(this.loading && this.scope === "global") && i < Math.min(results.length, this.offset + this.visibleCount()); i++) {
      const result = results[i]!;
      const prefix = i === this.selected ? this.theme.fg("accent", " ❯ ") : "   ";
      const date = age(result.prompt.timestamp);
      const available = Math.max(1, inner - date.length - 6);
      const firstMatch = result.ranges[0]?.[0] ?? 0;
      const start = firstMatch > available - 12 ? Math.max(0, firstMatch - Math.floor(available / 4)) : 0;
      const snippet = `${start ? "…" : ""}${result.preview.slice(start, start + Math.max(200, available * 2))}`;
      const shifted = result.ranges.map(([from, to]): [number, number] => [from - start + (start ? 1 : 0), to - start + (start ? 1 : 0)]);
      lines.push(row(prefix + truncateToWidth(highlight(snippet, shifted, this.theme), available, "…") + this.theme.fg("dim", `  ${date}`)));
      if (this.scope === "global") {
        const cwd = result.prompt.cwd || "(unknown directory)";
        const home = homedir();
        const source = cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
        lines.push(row(this.theme.fg("dim", `   ${source.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`)));
      }
    }
    lines.push(row(""));
    lines.push(row(this.theme.fg("dim", ` ↑↓/C-p,n/C-k,j navigate · enter insert · tab ${this.scope === "project" ? "global" : "project"} · esc/C-r close · ${results.length} matches`)));
    lines.push(border("╰" + "─".repeat(inner) + "╯"));
    return lines;
  }
}

export default function (pi: ExtensionAPI): void {
  const open = async (ctx: ExtensionContext, scope: "project" | "global" = "project") => {
    if (ctx.mode !== "tui") return;
    const manager = ctx.sessionManager;
    const sessionDir = manager.getSessionDir();
    const standardRoot = join(getAgentDir(), "sessions");
    const isStandard = dirname(sessionDir) === standardRoot;
    const root = isStandard ? standardRoot : sessionDir;
    const load = (directory: string, shared: boolean) => loadPrompts(directory, shared,
      join(getAgentDir(), "prompt-history", `${createHash("sha256").update(directory).digest("hex").slice(0, 16)}.json`));
    const prompts = await load(scope === "project" ? sessionDir : root, scope === "project" || !isStandard);
    const original = ctx.ui.getEditorText();
    const selected = await ctx.ui.custom<string | undefined>(
      (tui, theme, _keys, done) => new HistoryPicker(prompts, ctx.cwd, tui, theme, done, original, scope,
        scope === "project" ? () => load(root, !isStandard) : undefined),
      { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 } },
    );
    if (selected !== undefined) ctx.ui.setEditorText(selected);
  };

  pi.registerShortcut("ctrl+r", { description: "Search prompt history (Tab: project/global)", handler: open });
  pi.registerCommand("prompt-history", {
    description: "[project | global] — Search saved prompts (Tab toggles scope)",
    getArgumentCompletions: (prefix) => ["project", "global"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const scope = args.trim() || "project";
      if (scope !== "project" && scope !== "global") {
        ctx.ui.notify("Usage: /prompt-history [project | global]", "warning");
        return;
      }
      await open(ctx, scope);
    },
  });
}
