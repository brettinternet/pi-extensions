// Optional cross-package regression: real Pi runtime, real producer and loop.
// Child execution is a filesystem/event fixture; no model network or subprocess child.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

const [source, order, reload] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-subagents-sdk-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "subagents");
const { currentCompletionOwnerId } = await import(path.join(source, "src/shared/completion-owner.ts"));
const loop = fileURLToPath(new URL("../../extensions/loop/index.ts", import.meta.url));
const producer = path.join(source, "index.ts");
const settingsManager = SettingsManager.inMemory({});
const sessionManager = SessionManager.inMemory(root);
const sessionId = sessionManager.getSessionId();
const runId = randomUUID();
const asyncDir = path.join(root, "review");
fs.mkdirSync(asyncDir);
function writeStatus(state) {
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId, sessionId, completionOwnerId: currentCompletionOwnerId(), mode: "workflow", state,
    startedAt: Date.now(), lastUpdate: Date.now(), cwd: root, pid: process.pid, steps: [],
  }));
}
writeStatus("running");
const faux = fauxProvider({ provider: "loop-regression", models: [{ id: "local" }], tokensPerSecond: 100_000 });
faux.setResponses([() => fauxAssistantMessage("Review is running."), () => fauxAssistantMessage("Review processed; fixes and commit complete.")]);
let api;
let session;
let launched = false;
let completed = false;
let replacements = 0;
let resolveBoundary;
const boundary = new Promise((resolve) => { resolveBoundary = resolve; });
const errors = [];
const loader = new DefaultResourceLoader({
  cwd: root, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: order === "producer-first" ? [producer, loop] : [loop, producer],
  extensionFactories: [(extension) => {
    api = extension;
    api.registerProvider(faux.provider);
    api.on("agent_start", () => {
      if (launched) return;
      launched = true;
      api.events.emit("subagent:async-started", { id: runId, sessionId, completionOwnerId: currentCompletionOwnerId(), mode: "workflow", asyncDir });
    });
    api.on("agent_settled", async () => {
      if (reload !== "reload" || completed) return;
      complete();
      await session.reload();
    });
  }],
});
function complete() {
  completed = true;
  writeStatus("complete");
  api.events.emit("subagent:async-complete", {
    id: runId, sessionId, completionOwnerId: currentCompletionOwnerId(), success: false,
    summary: "Review finished; parent must apply fixes and commit.",
  });
}
let timeout;
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, sessionManager, resourceLoader: loader, modelRuntime, model: faux.getModel("local"), noTools: "builtin" }));
  await session.bindExtensions({
    onError: (error) => errors.push(error),
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => {
        replacements++;
        assert.equal(session.getLastAssistantText(), "Review processed; fixes and commit complete.");
        assert.ok(session.messages.some((message) => message.role === "custom" && message.customType === "subagent-notify"));
        resolveBoundary();
        return { cancelled: true }; // Observe rollover without starting another iteration.
      },
      reload: () => session.reload(),
    },
  });
  sessionManager.appendCustomEntry("pi-loop-state-v1", {
    version: 1, runId: randomUUID(), prompt: "work", currentIteration: 1, remainingBudget: 1,
    pendingRetune: null, delay: 0, status: "active", phase: "running", retryCount: 0, ownerSessionId: sessionId,
  });
  await session.prompt("Launch an async review and yield.");
  if (reload !== "reload") {
    assert.equal(replacements, 0, "yield must not consume an iteration");
    complete();
  }
  await Promise.race([boundary, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("loop did not resume after parent processing")), 10_000); })]);
  await session.waitForIdle();
  assert.equal(replacements, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ order, reload, replacements, parentProcessed: true }));
} finally {
  clearTimeout(timeout);
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  // Retain the isolated temporary fixture for diagnosis; never touch live sessions.
}
