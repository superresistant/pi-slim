#!/usr/bin/env node
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const ts = require(path.join(os.homedir(), "dev/pi/agent-bus/node_modules/typescript"));

const root = path.resolve(__dirname, "..");
const relocatedSessions = new Map();
function loadExtension(sourcePath) {
  const source = readFileSync(sourcePath, "utf8").replaceAll("import.meta.url", JSON.stringify(require("node:url").pathToFileURL(sourcePath).href));
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const loaded = new Module(`${sourcePath}.test.cjs`, module);
  loaded.filename = `${sourcePath}.test.cjs`;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = id => id === "@earendil-works/pi-coding-agent"
    ? { getSessionIdentityPath: file => relocatedSessions.get(file) ?? file }
    : originalRequire(id);
  loaded._compile(output, loaded.filename);
  return loaded.exports.default;
}
const temp = mkdtempSync(path.join(os.tmpdir(), "pi-notify-test-"));
const notifySend = path.join(temp, "notify-send");
writeFileSync(notifySend, "#!/bin/sh\n");
chmodSync(notifySend, 0o755);
const old = { spawn: childProcess.spawn, execFile: childProcess.execFile, PATH: process.env.PATH, DISPLAY: process.env.DISPLAY };
const notifications = [];
const statuses = [];
const execCalls = [];
let kittyReload = (callback) => setImmediate(() => callback(null, "", ""));
childProcess.spawn = (command, args) => {
  notifications.push([command, args]);
  return { on() { return this; }, unref() {} };
};
childProcess.execFile = (_command, _args, _options, callback) => {
  execCalls.push({ command: _command, args: _args, options: _options });
  if (_command === "kitten") return kittyReload(callback);
  if (_args[0] === "agent-status") statuses.push(_args[1]);
  setImmediate(() => callback(null, "", ""));
  return { on() { return this; } };
};
process.env.PATH = `${temp}:${old.PATH || ""}`;
process.env.DISPLAY = ":test";

const handlers = new Map();
const branch = [];
const events = new EventEmitter();
const bus = { on(channel, handler) { events.on(channel, handler); return () => events.off(channel, handler); },
  emit(channel, payload) { events.emit(channel, payload); }, listenerCount(channel) { return events.listenerCount(channel); } };
const pi = {
  events: bus,
  on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
  sendUserMessage() {},
};
loadExtension(path.join(root, "index.ts"))(pi);
const ctx = {
  mode: 'tui',
  hasUI: true,
  cwd: temp,
  model: { provider: "test", id: "model" },
  sessionManager: { getSessionFile: () => "/tmp/test.jsonl", getLeafId: () => null, getBranch: () => branch },
  isIdle: () => true,
  ui: { notify() {} },
};
const aborted = [{ role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted", content: [] }];
const currentAbort = [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] }];
const balancedToolAbort = [
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-1", name: "bash" }] },
  { role: "toolResult", toolCallId: "tool-1", isError: true, content: [{ type: "text", text: "Command aborted" }] },
];
const failure = [{ role: "assistant", stopReason: "error", errorMessage: "Provider failed", content: [] }];
const success = { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Worker finished." }] }], aborted: false };
const cancelled = { messages: balancedToolAbort, aborted: true };

async function expectNotification(event, count, label) {
  const before = notifications.length;
  await emit("agent_end", event);
  assert.equal(notifications.length - before, count, label);
}

async function emit(name, event = {}) {
  for (const handler of handlers.get(name) || []) await handler(event, ctx);
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function testNativeSettlement() {
  const session = ctx.sessionManager.getSessionFile();
  const binding = { taskId: "task-a", executionId: "execution-a", roundId: "round-1" };
  const receipt = (status, extra = {}) => ({ ...binding, status, session, entryId: `receipt-${status}`, ...extra });
  const settle = async (value) => emit("agent_settled", { executionReceipt: value });
  const end = async (execution, event = success) => {
    ctx.execution = execution;
    await expectNotification(event, 0, "native end notified before settlement");
    delete ctx.execution;
  };
  let before = notifications.length;
  let stateBefore = statuses.length;
  await end(binding);
  await settle(receipt("suspended"));
  assert.equal(notifications.length, before, "suspended checkpoint notified");
  assert.deepEqual(statuses.slice(stateBefore), ["clear"], "suspension advertised done");
  await settle(receipt("completed"));
  assert.equal(notifications.length, before, "suspended content leaked into later settlement");

  await end({ ...binding, roundId: "round-2" }, { messages: failure, aborted: false });
  await end({ ...binding, roundId: "round-2" });
  assert.equal(notifications.length, before, "native retry notified");
  stateBefore = statuses.length;
  await settle(receipt("started"));
  assert.equal(statuses.length, stateBefore, "started receipt advertised done");
  for (const wrong of [{ executionId: "other" }, { taskId: "other" }, { session: "/tmp/other.jsonl" }]) {
    await settle(receipt("completed", wrong));
    assert.equal(notifications.length, before, "unrelated receipt mixed execution content");
  }
  await settle(receipt("completed"));
  assert.equal(notifications.length, before + 1);
  assert.equal(notifications.at(-1)[1][2], "Worker finished.", "retry error replaced final content");
  assert.equal(statuses.at(-1), "done");
  await settle(receipt("completed"));
  assert.equal(notifications.length, before + 1, "duplicate settlement notified");

  for (const [status, event] of [["failed", { messages: failure, aborted: false }], ["aborted", cancelled]]) {
    before = notifications.length;
    await end(binding, event);
    await settle(receipt(status));
    assert.equal(notifications.length, before + 1, `${status} settlement was suppressed`);
    assert.equal(statuses.at(-1), "done");
  }
  before = notifications.length;
  await end(binding, cancelled);
  await settle(receipt("aborted"));
  assert.equal(notifications.length, before + 1, "unmarked native abort was suppressed");

  before = notifications.length;
  await end(binding, { messages: failure, aborted: false });
  const other = { ...binding, executionId: "execution-b" };
  await end(other);
  await settle(receipt("completed", other));
  assert.equal(notifications.at(-1)[1][2], "Worker finished.");
  await settle(receipt("failed"));
  assert.equal(notifications.length, before + 2);
  assert.equal(notifications.at(-1)[1][2], "Provider failed", "independent executions shared last body");

  before = notifications.length;
  await end(binding);
  await emit("session_start", { reason: "reload" });
  await settle(receipt("completed"));
  assert.equal(notifications.length, before, "session start retained native body");
  await expectNotification(success, 1, "unbound legacy end no longer notified immediately");
  await emit("agent_settled");
  assert.equal(notifications.length, before + 1, "legacy settled duplicated notification");
  assert.equal(statuses.at(-1), "done");
  await end(binding);
}

async function testEmptyParleyCompletion() {
  const session = ctx.sessionManager.getSessionFile();
  const empty = '[PARLEY COMPLETE]\n\n--- /home/sr/dev/pi/gmail-api state=succeeded ---\n\n';
  const multiple = `${empty}\n\n--- /home/sr/dev/pi/mail-router state=succeeded ---\n\n`;
  const nonempty = `${empty}Actual result.`;
  const id = 'parley:79455b1e-6721-4dd0-95bc-48e570989f7f:complete';
  const input = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const entry = (text, binding, kind = 'parley', deliveryId = id) => ({
    type: 'message', message: { ...input(text), delivery: { id: deliveryId, kind, execution: binding } },
  });
  let counter = 0;
  const check = async ({ text = empty, kind = 'parley', deliveryId = id, receiptId = id,
                         extraUser = false, wrongExecution = false, status = 'completed', expected = 0, aggregate = false }) => {
    const binding = { taskId: 'task-parley', executionId: `exec-${++counter}` };
    const event = { messages: [input(text), ...(extraUser ? [input('Another request')] : []), ...success.messages], aborted: false };
    branch.splice(0, branch.length, entry(text, wrongExecution ? { ...binding, executionId: 'other' } : binding, kind, deliveryId));
    const before = notifications.length;
    ctx.execution = binding;
    await emit('agent_end', event);
    delete ctx.execution;
    assert.equal(notifications.length, before, 'native Parley input notified before receipt');
    await emit('agent_settled', { executionReceipt: { ...binding, status, session, entryId: `entry-${counter}`, inputDeliveryId: receiptId } });
    assert.equal(notifications.length, before + expected, `wrong Parley notification for ${JSON.stringify({ status, text, kind, deliveryId, receiptId, extraUser })}`);
    if (expected) assert.equal(notifications.at(-1)[1][2], `${aggregate ? 'Parley aggregate · ' : ''}Worker finished.`);
    assert.equal(statuses.at(-1), 'done');
    branch.splice(0);
  };
  await check({});
  await check({ text: multiple });
  await check({ text: nonempty, expected: 1, aggregate: true });
  await check({ kind: 'user', expected: 1 });
  await check({ deliveryId: 'parley:other:complete', expected: 1 });
  await check({ wrongExecution: true, expected: 1 });
  await check({ receiptId: null, expected: 1 });
  await check({ extraUser: true, expected: 1 });
  await check({ status: 'failed', expected: 1, aggregate: true });
  await check({ text: '[PARLEY COMPLETE]\n\n--- /tmp/test state=failed ---\n\n', expected: 1, aggregate: true });
  await expectNotification({ messages: [input(empty), ...success.messages], aborted: false }, 1, 'legacy unbound Parley text suppressed');
}

async function testKittyRestart() {
  const oldSocket = process.env.KITTY_LISTEN_ON;
  const notices = [];
  const restartCtx = { ...ctx, ui: { notify: (...args) => notices.push(args) } };
  const calls = () => execCalls.filter(call => call.command === "kitten");
  const fresh = () => {
    const events = new Map();
    loadExtension(path.join(root, "index.ts"))({ events: { on: () => () => {} }, on: (name, handler) => events.set(name, handler) });
    return (name, reason) => events.get(name)({ reason }, restartCtx);
  };
  try {
    process.env.KITTY_LISTEN_ON = "unix:/tmp/exact kitty.sock";
    for (const reason of [undefined, "quit", "reload", "new", "resume", "fork"]) {
      const event = fresh();
      const before = calls().length;
      await event("session_start", "startup");
      await event("session_shutdown", reason);
      assert.equal(calls().length, before, `${reason} reloaded Kitty config`);
    }
    for (const socket of [undefined, ""]) {
      if (socket === undefined) delete process.env.KITTY_LISTEN_ON;
      else process.env.KITTY_LISTEN_ON = socket;
      const before = calls().length;
      await fresh()("session_shutdown", "restart");
      assert.equal(calls().length, before, "missing socket fell back to terminal control");
    }
    process.env.KITTY_LISTEN_ON = "unix:/tmp/exact kitty.sock";
    const event = fresh();
    await event("session_start", "startup");
    assert.deepEqual(execCalls.at(-1).args, ["session-file", "/tmp/test.jsonl"]);
    const before = calls().length;
    const start = execCalls.length;
    let complete;
    kittyReload = callback => { complete = callback; };
    let finished = false;
    const shutdown = event("session_shutdown", "restart").then(() => { finished = true; });
    await waitFor(() => complete);
    assert.equal(finished, false, "shutdown did not await config reload");
    assert.deepEqual(execCalls.slice(start).map(call => call.args), [
      ["agent-status", "clear"], ["session-file", ""],
      ["@", "--to", "unix:/tmp/exact kitty.sock", "load-config"],
    ]);
    assert.deepEqual(calls().at(-1).options, { timeout: 1500 });
    await event("session_shutdown", "restart");
    assert.equal(calls().length, before + 1, "duplicate shutdown repeated config reload");
    complete(null, "", "");
    await shutdown;
    assert.equal(finished, true);
    assert.equal(notices.length, 0);
    for (const mode of ["ENOENT", "timeout", "throw"]) {
      const error = Object.assign(new Error(mode), mode === "timeout" ? { killed: true, signal: "SIGTERM" } : { code: mode });
      kittyReload = callback => {
        if (mode === "throw") throw error;
        setImmediate(() => callback(error, "", ""));
      };
      const event = fresh();
      const before = calls().length;
      await assert.doesNotReject(event("session_shutdown", "restart"));
      assert.deepEqual(notices.at(-1), [`Kitty config reload failed: ${mode}`, "warning"]);
      await event("session_shutdown", "restart");
      assert.equal(calls().length, before + 1, "failed reload retried during shutdown");
    }
    assert.equal(notices.length, 3);
    console.log("PASS  restart-only Kitty config reload: exact socket, awaited timeout, once, metadata and nonfatal failures");
  } finally {
    if (oldSocket === undefined) delete process.env.KITTY_LISTEN_ON;
    else process.env.KITTY_LISTEN_ON = oldSocket;
    kittyReload = callback => setImmediate(() => callback(null, "", ""));
  }
}

async function testVisibility() {
  await emit("session_start", { reason: "startup" });
  for (const [event, completion] of [
    [success, true], [{ messages: failure, aborted: false }, false],
    [cancelled, false], [{ messages: aborted }, false],
    [{ messages: currentAbort, aborted: false }, false],
    [{ messages: [...failure, ...success.messages], aborted: false }, true],
  ]) {
    await expectNotification(event, 1, "legacy notification missing");
    assert.equal(notifications.at(-1)[1].includes("--completion"), completion);
  }
  const binding = { taskId: "visibility", executionId: "execution", roundId: "round" };
  const end = async (event) => {
    ctx.execution = binding;
    await expectNotification(event, 0, "native notification preceded receipt");
    delete ctx.execution;
  };
  for (const [status, event, completion] of [
    ["completed", success, true], ["failed", success, false], ["aborted", success, false],
    ["completed", { messages: failure, aborted: false }, false],
    ["completed", cancelled, false],
  ]) {
    await end({ messages: failure, aborted: false });
    await end(event);
    const before = notifications.length;
    await emit("agent_settled", { executionReceipt: {
      ...binding, status, session: ctx.sessionManager.getSessionFile(), entryId: `visibility-${status}`,
    } });
    assert.equal(notifications.length, before + 1);
    assert.equal(notifications.at(-1)[1].includes("--completion"), completion, `${status} attention classification`);
  }
  await emit("session_shutdown");
  console.log("PASS  completion visibility opt-in; legacy/native errors and aborts retained, retries and receipts authoritative");
}

async function testRelocatedSession() {
  const getSessionFile = ctx.sessionManager.getSessionFile;
  const isIdle = ctx.isIdle;
  const identity = "/tmp/original/session.jsonl";
  const storage = "/tmp/moved/session.jsonl";
  relocatedSessions.set(storage, identity);
  ctx.sessionManager.getSessionFile = () => storage;
  const binding = { taskId: "relocated-task", executionId: "relocated-execution" };
  const receipt = status => ({ ...binding, status, session: identity, entryId: `relocated-${status}` });
  const end = async () => {
    await emit("before_agent_start");
    ctx.execution = binding;
    await expectNotification(success, 0, "relocated native end notified before settlement");
    delete ctx.execution;
  };
  try {
    await emit("session_start", { reason: "startup" });
    assert.deepEqual(execCalls.at(-1).args, ["session-file", storage], "Kitty must retain launchable storage path");
    for (const status of ["completed", "failed", "aborted", "suspended"]) {
      await end();
      const before = notifications.length;
      const beforeState = statuses.length;
      await emit("agent_settled", { executionReceipt: { ...receipt(status), session: "/tmp/unrelated.jsonl" } });
      assert.equal(statuses.length, beforeState, "unrelated receipt cleared busy state");
      await emit("agent_settled", { executionReceipt: receipt(status) });
      assert.equal(statuses.at(-1), status === "suspended" ? "clear" : "done");
      assert.equal(notifications.length, before + (status === "suspended" ? 0 : 1));
      const settledState = statuses.length;
      await emit("agent_settled", { executionReceipt: receipt(status) });
      assert.equal(statuses.length, settledState, "duplicate receipt changed state");
      assert.equal(notifications.length, before + (status === "suspended" ? 0 : 1));
    }
    await end();
    const busyState = statuses.length;
    ctx.isIdle = () => false;
    await emit("agent_settled", { executionReceipt: receipt("completed") });
    assert.equal(statuses.length, busyState, "settlement overwrote a new busy run");
    ctx.isIdle = isIdle;
    await end();
    ctx.sessionManager.getSessionFile = () => "/tmp/different-session.jsonl";
    const before = notifications.length;
    const beforeState = statuses.length;
    await emit("agent_settled", { executionReceipt: receipt("completed") });
    assert.equal(notifications.length, before, "receipt crossed conversation boundary");
    assert.equal(statuses.length, beforeState, "old conversation cleared current busy state");
    console.log("PASS relocated-session settlement: canonical identity, launchable metadata, terminal states, duplicate/unrelated receipts and busy/session isolation");
  } finally {
    ctx.sessionManager.getSessionFile = getSessionFile;
    ctx.isIdle = isIdle;
    delete ctx.execution;
    relocatedSessions.clear();
    await emit("session_shutdown");
  }
}

async function testAutopilot() {
  const channel = 'agent-bus:autopilot:v1';
  const valid = { pid: process.pid, cwd: ctx.cwd, session: ctx.sessionManager.getSessionFile(), state: 'waiting', reason: 'Awaiting reviewer' };
  const before = notifications.length;
  for (const invalid of [{ ...valid, pid: process.pid + 1 }, { ...valid, cwd: '/tmp/wrong' },
    { ...valid, session: '/tmp/wrong.jsonl' }, { ...valid, state: 'on' }, { ...valid, reason: 42 }]) bus.emit(channel, invalid);
  assert.equal(notifications.length, before, 'unmatched autopilot event notified');
  bus.emit(channel, { ...valid, reason: 'Awaiting\nreviewer\x1b[31m' });
  assert.equal(notifications.length, before + 1);
  assert.equal(notifications.at(-1)[1][2], 'Autopilot waiting: Awaiting reviewer[31m');
  assert.equal(notifications.at(-1)[1].includes('--completion'), false);
  bus.emit(channel, { ...valid, state: 'off', reason: 'PAUSE_UNSAFE' });
  assert.equal(notifications.at(-1)[1][2], 'Autopilot stopped: PAUSE_UNSAFE');
  const pulse = { messages: [{ role: 'custom', customType: 'bus-autopilot', content: 'Continue' }, ...success.messages], aborted: false };
  await expectNotification(pulse, 0, 'autopilot pulse notified');
  const binding = { taskId: 'autopilot-task', executionId: 'autopilot-execution' };
  ctx.execution = binding;
  await expectNotification(pulse, 0, 'bound autopilot pulse notified before receipt');
  delete ctx.execution;
  await emit('agent_settled', { executionReceipt: { ...binding, status: 'completed', session: valid.session, entryId: 'autopilot-settled' } });
  assert.equal(notifications.length, before + 2, 'bound autopilot pulse notified after receipt');
  assert.equal(statuses.at(-1), 'done');
  await expectNotification(success, 1, 'later normal work stayed muted after autopilot');
}

async function main() {
  if (process.argv.includes("--relocation")) {
    await testRelocatedSession();
    return;
  }
  if (process.argv.includes("--visibility")) {
    await testVisibility();
    return;
  }
  if (process.argv.includes("--kitty-restart")) {
    await emit("session_shutdown");
    await testKittyRestart();
    return;
  }
  await emit("session_start", { reason: "startup" });
  assert.equal(bus.listenerCount('agent-bus:autopilot:v1'), 1);
  await testAutopilot();
  await expectNotification({ messages: aborted, aborted: true }, 1, "manual abort was suppressed");
  await expectNotification(cancelled, 1, "tool cancellation was suppressed");
  await expectNotification({ messages: failure, aborted: false }, 1, "genuine failure was suppressed");
  await expectNotification(success, 1, "successful completion wake was suppressed");
  for (const kind of [{ customType: 'bus-handoff' }, { customType: 'bus', details: { kind: 'handoff' } }]) {
    await expectNotification({ messages: [{ role: 'custom', content: 'Step', ...kind }, ...success.messages], aborted: false }, 0,
      'bus handoff step notified');
  }
  for (const kind of [{ customType: 'bus-continue' }, { customType: 'bus', details: { kind: 'result' } }]) {
    await expectNotification({ messages: [{ role: 'custom', content: 'Work', ...kind }, ...success.messages], aborted: false }, 1,
      'ordinary bus completion suppressed');
  }

  assert.equal(process.listenerCount("pi-parley:expected-origin-abort:v1"), 0);
  assert.equal(process.listenerCount("pi-subagent:expected-origin-abort:v1"), 0);
  await emit("session_shutdown");
  assert.equal(bus.listenerCount('agent-bus:autopilot:v1'), 0);
  handlers.clear();
  loadExtension(path.join(root, "index.ts"))(pi);
  await emit("session_start", { reason: "reload" });
  assert.equal(bus.listenerCount('agent-bus:autopilot:v1'), 1);
  await expectNotification(cancelled, 1, "reload suppressed manual abort");
  await testNativeSettlement();
  await testEmptyParleyCompletion();
  const beforeShutdown = notifications.length;
  await emit("session_shutdown");
  assert.equal(bus.listenerCount('agent-bus:autopilot:v1'), 0);
  bus.emit('agent-bus:autopilot:v1', { pid: process.pid, cwd: ctx.cwd, session: ctx.sessionManager.getSessionFile(), state: 'off', reason: 'stale' });
  assert.equal(notifications.length, beforeShutdown, 'shutdown retained autopilot listener');
  await emit("agent_settled", { executionReceipt: {
    taskId: "task-a", executionId: "execution-a", session: ctx.sessionManager.getSessionFile(), entryId: "shutdown", status: "completed",
  } });
  assert.equal(notifications.length, beforeShutdown, "shutdown retained native body");
  console.log("PASS  native suspension, settled completion/error/abort, retry content and exact execution correlation");
  console.log("PASS  legacy Parley aggregates still correlated; unmarked aborts and failures notify");
  console.log("PASS  bus autopilot pulses silent, exact off/waiting events notify; lifecycle listeners cleaned");
  console.log("PASS  bus handoff custom steps suppressed, ordinary bus successor/results notify; no legacy marker listeners");
  await testKittyRestart();
  await testNonTuiPaneIdentity();
  await testVisibility();
  await testRelocatedSession();
}

async function testNonTuiPaneIdentity() {
  for (const mode of ['rpc', 'json', 'print']) {
    const events = new Map();
    loadExtension(path.join(root, 'index.ts'))({ events: { on: () => () => {} }, on: (name, handler) => events.set(name, handler) });
    const before = execCalls.length;
    const context = { ...ctx, mode, hasUI: mode === 'rpc' };
    for (const name of ['session_start', 'before_agent_start', 'agent_start', 'tool_execution_start', 'agent_settled', 'session_shutdown']) {
      await events.get(name)({ reason: 'restart' }, context);
    }
    assert.equal(execCalls.length, before, `${mode} lifecycle must not change parent pane metadata or reload Kitty`);
  }
  console.log('PASS  RPC/JSON/print workers never publish or clear parent pane identity');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  childProcess.spawn = old.spawn;
  childProcess.execFile = old.execFile;
  if (old.PATH === undefined) delete process.env.PATH; else process.env.PATH = old.PATH;
  if (old.DISPLAY === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = old.DISPLAY;
  rmSync(temp, { recursive: true, force: true });
});
