import type { DiagnosticResult, LspDiagnostic } from "./client.ts";

export const MAX_OUTPUT_CHARS = 24_000;
export const MAX_DETAIL_TEXT = 2_000;
export const MAX_RESULTS = 50;

const severityNames: Record<number, string> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
const symbolKinds: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function", 13: "Variable", 14: "Constant", 15: "String",
  16: "Number", 17: "Boolean", 18: "Array", 19: "Object", 20: "Key", 21: "Null", 22: "EnumMember",
  23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter",
};

export interface BoundedResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = "… [truncated]";
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function location(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.uri !== "string" || !isRecord(value.range)) return undefined;
  const range = value.range;
  const start = isRecord(range.start) ? range.start : undefined;
  const end = isRecord(range.end) ? range.end : undefined;
  if (!start || !end || typeof start.line !== "number" || typeof start.character !== "number" || typeof end.line !== "number" || typeof end.character !== "number") return undefined;
  return {
    path: filePath(value.uri),
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

function filePath(uri: string): string {
  try { return decodeURIComponent(new URL(uri).pathname); } catch { return truncate(uri, MAX_DETAIL_TEXT); }
}

function diagnostic(value: LspDiagnostic): Record<string, unknown> {
  return {
    severity: value.severity ? severityNames[value.severity] ?? `severity-${value.severity}` : "unspecified",
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.source === undefined ? {} : { source: truncate(value.source, 120) }),
    message: truncate(value.message, MAX_DETAIL_TEXT),
    start: { line: value.range.start.line + 1, column: value.range.start.character + 1 },
    end: { line: value.range.end.line + 1, column: value.range.end.character + 1 },
  };
}

function normalizeSymbol(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const result: Record<string, unknown> = {
    name: truncate(value.name, 300),
    ...(typeof value.kind === "number" ? { kind: symbolKinds[value.kind] ?? `kind-${value.kind}` } : {}),
  };
  if (typeof value.containerName === "string") result.containerName = truncate(value.containerName, 300);
  if (isRecord(value.location)) {
    const locationInfo = location(value.location);
    if (locationInfo) result.location = locationInfo;
  } else {
    const range = isRecord(value.selectionRange) ? value.selectionRange : value.range;
    if (isRecord(range) && isRecord(range.start) && typeof range.start.line === "number" && typeof range.start.character === "number") {
      result.location = { line: range.start.line + 1, column: range.start.character + 1 };
    }
    if (Array.isArray(value.children) && depth < 2) {
      result.children = value.children.slice(0, 10).map((child) => normalizeSymbol(child, depth + 1)).filter(Boolean);
    }
  }
  return result;
}

function hoverText(value: unknown): string {
  if (!isRecord(value) || value.contents === undefined) return "No hover information at this position.";
  const contents = value.contents;
  const parts: string[] = [];
  const append = (item: unknown) => {
    if (typeof item === "string") parts.push(truncate(item, MAX_DETAIL_TEXT * 4));
    else if (isRecord(item) && typeof item.value === "string") parts.push(item.language ? `\`\`\`${truncate(String(item.language), 80)}\n${truncate(item.value, MAX_DETAIL_TEXT * 4)}\n\`\`\`` : truncate(item.value, MAX_DETAIL_TEXT * 4));
  };
  if (Array.isArray(contents)) contents.forEach(append);
  else append(contents);
  return truncate(parts.join("\n\n") || "No hover information at this position.", MAX_DETAIL_TEXT * 4);
}

function bounded(status: string, summary: string, data: Record<string, unknown>): BoundedResult {
  let details: Record<string, unknown> = { status, ...data };
  if (JSON.stringify(details).length > MAX_OUTPUT_CHARS - 2_000) {
    const serializedData = JSON.stringify(data);
    let dataLength = MAX_OUTPUT_CHARS - 4_000;
    details = {
      status,
      ...(typeof data.total === "number" ? { total: data.total } : {}),
      truncated: true,
      summary: truncate(summary, 1_000),
      data: truncate(serializedData, dataLength),
    };
    while (JSON.stringify(details).length > MAX_OUTPUT_CHARS && dataLength > 0) {
      dataLength = Math.floor(dataLength * 0.8);
      details.data = truncate(serializedData, dataLength);
    }
  }
  const text = truncate(`${summary}\n${JSON.stringify(details, null, 2)}`, MAX_OUTPUT_CHARS);
  return { content: [{ type: "text", text }], details };
}

export function formatDiagnostics(result: DiagnosticResult, limit: number): BoundedResult {
  const diagnostics = result.diagnostics.slice(0, limit).map(diagnostic);
  const total = result.total ?? result.diagnostics.length;
  const truncated = result.status === "unknown" ? Boolean(result.truncated) || total > diagnostics.length : result.truncated || total > diagnostics.length;
  if (result.status === "unknown") {
    return bounded("unknown", `Diagnostics unknown: ${result.reason}`, {
      reason: truncate(result.reason, MAX_DETAIL_TEXT),
      diagnostics,
      total,
      truncated,
      ...(result.advisory ? { advisory: true } : {}),
    });
  }
  const summary = result.status === "clean"
    ? `Diagnostics: clean (version ${result.version}, ${result.source} report).`
    : `Diagnostics: findings (${total} reported; version ${result.version}, ${result.source} report).`;
  return bounded(result.status, summary, { diagnostics, total, truncated, version: result.version, source: result.source });
}

export function formatLocations(value: unknown, limit: number): BoundedResult {
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (value === null || value === undefined) entries = [];
  else if (isRecord(value) && typeof value.targetUri === "string") {
    entries = [{ uri: value.targetUri, range: value.targetSelectionRange ?? value.targetRange }];
  } else entries = [value];
  const shown = entries.slice(0, limit).map((item) => {
    if (isRecord(item) && typeof item.targetUri === "string") {
      return location({ uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange });
    }
    return location(item);
  }).filter((item): item is Record<string, unknown> => item !== undefined);
  return bounded("results", `Found ${entries.length} location(s).`, { locations: shown, total: entries.length, truncated: entries.length > shown.length });
}

export function formatSymbols(value: unknown, limit: number): BoundedResult {
  const entries = Array.isArray(value) ? value : [];
  const shown = entries.slice(0, limit).map((entry) => normalizeSymbol(entry)).filter((item): item is Record<string, unknown> => item !== undefined);
  return bounded("results", `Found ${entries.length} symbol(s).`, { symbols: shown, total: entries.length, truncated: entries.length > shown.length });
}

export function formatHover(value: unknown): BoundedResult {
  const text = hoverText(value);
  return bounded("result", text, { hover: text });
}

export function formatResult(value: unknown, limit: number): BoundedResult {
  if (Array.isArray(value)) return formatSymbols(value, limit);
  if (value === null || value === undefined) return bounded("not-found", "No result found at this position.", { result: null });
  if (isRecord(value) && (typeof value.uri === "string" || typeof value.targetUri === "string")) return formatLocations(value, limit);
  return bounded("result", truncate(JSON.stringify(value), MAX_DETAIL_TEXT), { result: value });
}
