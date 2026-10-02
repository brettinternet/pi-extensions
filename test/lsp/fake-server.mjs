import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

if (process.env.FAKE_LSP_CHILD_PID_FILE) {
  spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.env.FAKE_LSP_CHILD_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
  `], { stdio: "ignore" });
}
if (process.env.FAKE_LSP_IGNORE_SHUTDOWN) process.on("SIGTERM", () => {});

let buffer = Buffer.alloc(0);
let currentDocuments = new Map();
let reportIds = new Map();
let diagnosticRequestCount = 0;
const logPath = process.env.FAKE_LSP_LOG;

function log(message) {
  if (logPath) appendFileSync(logPath, `${message}\n`);
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function diagnostics(text) {
  if (!text.includes("BAD")) return [];
  return [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    severity: 1,
    source: "fake-lsp",
    message: "fake finding from test server",
  }];
}

function push(uri, version, text) {
  const mode = process.env.FAKE_LSP_PUSH_MODE ?? "versioned";
  if (mode === "none") return;
  const publish = () => {
    const replay = process.env.FAKE_LSP_REPLAY_FILE;
    const params = replay && existsSync(replay)
      ? JSON.parse(readFileSync(replay, "utf8"))
      : { uri, diagnostics: diagnostics(text), ...(mode === "versioned" ? { version } : mode === "stale" ? { version: Math.max(0, version - 1) } : {}) };
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params });
  };
  const delay = Number(process.env.FAKE_LSP_PUSH_DELAY_MS ?? 0);
  if (delay > 0) setTimeout(publish, delay);
  else publish();
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function errorResponse(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function onMessage(message) {
  if (message.method === "initialize") {
    log(`initialize:${process.pid}`);
    log(`initializationOptions:${JSON.stringify(message.params.initializationOptions ?? null)}`);
    const delay = Number(process.env.FAKE_LSP_INIT_DELAY_MS ?? 0);
    const initialize = () => response(message.id, {
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        ...(process.env.FAKE_LSP_PULL === "true" ? { diagnosticProvider: { identifier: "fake" } } : {}),
      },
    });
    if (delay > 0) setTimeout(initialize, delay);
    else initialize();
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "textDocument/didOpen") {
    const doc = message.params.textDocument;
    log(`didOpen:${doc.languageId}`);
    log(`sync:${JSON.stringify(doc)}`);
    currentDocuments.set(doc.uri, { version: doc.version, text: doc.text });
    push(doc.uri, doc.version, doc.text);
    return;
  }
  if (message.method === "textDocument/didChange") {
    const uri = message.params.textDocument.uri;
    const doc = currentDocuments.get(uri) ?? { text: "" };
    doc.version = message.params.textDocument.version;
    doc.text = message.params.contentChanges.at(-1)?.text ?? doc.text;
    currentDocuments.set(uri, doc);
    log(`sync:${JSON.stringify(doc)}`);
    push(uri, doc.version, doc.text);
    return;
  }
  if (message.method === "textDocument/didClose") {
    currentDocuments.delete(message.params.textDocument.uri);
    return;
  }
  if (message.method === "textDocument/diagnostic") {
    if (process.env.FAKE_LSP_CRASH_MARKER && !existsSync(process.env.FAKE_LSP_CRASH_MARKER)) {
      writeFileSync(process.env.FAKE_LSP_CRASH_MARKER, "crashed once");
      log("crash");
      process.exit(1);
    }
    diagnosticRequestCount++;
    const sequence = (process.env.FAKE_LSP_PULL_SEQUENCE ?? "full").split(",");
    const action = sequence[Math.min(diagnosticRequestCount - 1, sequence.length - 1)];
    const document = currentDocuments.get(message.params.textDocument.uri) ?? { text: "", version: 1 };
    const resultId = reportIds.get(message.params.textDocument.uri) ?? `report-${document.version}`;
    const reply = () => {
      if (action === "null") return response(message.id, null);
      if (action === "error") return errorResponse(message.id, -32601, "diagnostic request unsupported");
      if (action === "invalid") return response(message.id, { kind: "full", items: [null] });
      if (action === "unchanged") return response(message.id, { kind: "unchanged", resultId });
      const id = `report-${document.version}`;
      reportIds.set(message.params.textDocument.uri, id);
      response(message.id, { kind: "full", resultId: id, items: diagnostics(document.text) });
    };
    const delay = Number(process.env.FAKE_LSP_DIAGNOSTIC_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(reply, delay);
    else reply();
    return;
  }
  if (message.method === "textDocument/hover") {
    if (process.env.FAKE_LSP_CRASH_ON_HOVER) process.exit(1);
    response(message.id, { contents: { kind: "markdown", value: "**fake hover result**" } });
    return;
  }
  if (message.method === "textDocument/definition" || message.method === "textDocument/references") {
    const uri = message.params.textDocument.uri;
    const loc = { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } };
    response(message.id, message.method.endsWith("references") ? [loc] : loc);
    return;
  }
  if (message.method === "textDocument/documentSymbol" || message.method === "workspace/symbol") {
    response(message.id, [{ name: "FakeSymbol", kind: 12, location: { uri: "file:///fake.go", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } } }]);
    return;
  }
  if (message.method === "shutdown") {
    if (process.env.FAKE_LSP_IGNORE_SHUTDOWN) return;
    log("shutdown");
    response(message.id, null);
    return;
  }
  if (message.method === "exit") {
    if (process.env.FAKE_LSP_IGNORE_SHUTDOWN) return;
    log("exit");
    process.exit(0);
  }
  if (message.id !== undefined) response(message.id, null);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const delimiter = buffer.indexOf("\r\n\r\n");
    if (delimiter < 0) return;
    const header = buffer.subarray(0, delimiter).toString("ascii");
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length) || buffer.length < delimiter + 4 + length) return;
    const body = buffer.subarray(delimiter + 4, delimiter + 4 + length);
    buffer = buffer.subarray(delimiter + 4 + length);
    onMessage(JSON.parse(body.toString("utf8")));
  }
});
