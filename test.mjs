import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { getOsc8LinkAtColumn, matchesKey, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import slim from "./index.ts";

const wakeBackends = new Map();
const wakeCallbacks = new Set();
const wakeProofs = new WeakMap();
const shutdowns = new Set();
globalThis.__piSlimWakeFixture = {
	pendingWakes: (owner) => wakeBackends.get(owner.session)?.query(owner) ?? Promise.resolve({ owner, known: false, pending: [] }),
	watchPendingWakes(callback) { wakeCallbacks.add(callback); return () => wakeCallbacks.delete(callback); },
	hasLivePendingWake(snapshot) { return wakeProofs.get(snapshot)?.() ?? false; },
};
const wakeModule = `const fixture = globalThis.__piSlimWakeFixture;
export const pendingWakes = fixture.pendingWakes;
export const watchPendingWakes = fixture.watchPendingWakes;
export const hasLivePendingWake = fixture.hasLivePendingWake;`;
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier.endsWith("/subagent/pending-wakes.ts")) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(wakeModule)}` };
	return nextResolve(specifier, context);
} });
afterEach(() => {
	for (const shutdown of shutdowns) shutdown();
	shutdowns.clear();
	wakeBackends.clear();
});

const linkPattern = /\x1b\]8;;(pi-slim-copy:[^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g;

function fixture(cwd, options = {}) {
	const events = new Map();
	const bus = new Map();
	const commands = new Map();
	let delivery = options.delivery;
	let parley = options.parley;
	const entries = options.entries ?? [];
	let queries = 0;
	let renders = 0;
	const eventBus = {
		on: (name, handler) => bus.set(name, handler),
		emit(name, request) {
			if (name === "pi-handoff-queue:delivery-state:v1") {
				queries++;
				Object.assign(request, delivery);
			}
			if (name === "parley:pending-round:v1") Object.assign(request, parley);
			bus.get(name)?.(request);
		},
	};
	const terminal = Object.create({ get rows() { return 40; } });
	const tui = { terminal, requestRender() { renders++; } };
	const theme = { borderColor: (text) => text, fg: (_color, text) => text };
	let editor;
	let workingVisible;
	const ctx = {
		cwd,
		mode: options.mode ?? "tui",
		model: { id: "model" },
		getContextUsage: () => ({ percent: 12, tokens: 6000 }),
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => options.session ?? "/tmp/pi-slim-test-session.jsonl",
			getEntries: () => entries,
			getEntry: (id) => entries.find(entry => entry.id === id),
		},
		ui: {
			theme,
			setWorkingVisible: (visible) => { workingVisible = visible; },
			setFooter: (factory) => factory?.(tui, theme, {
				getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {},
			}),
			setEditorComponent: (factory) => {
				editor = factory?.(tui, theme, {
					matches: (data, action) => action === "app.message.followUp" && matchesKey(data, "alt+enter"),
				});
				if (editor && options.nativeSubmit) editor.submit = options.nativeSubmit;
			},
			notify() {},
		},
	};
	slim({
		events: eventBus,
		on: (event, handler) => events.set(event, (data = {}, context = ctx) => handler(data, context)),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() }),
		registerCommand: (name, command) => commands.set(name, command),
		getThinkingLevel: () => "off",
	});
	events.get("session_start")({}, ctx);
	shutdowns.add(() => events.get("session_shutdown")());
	return {
		get editor() { return editor; }, events, commands, ctx, terminal, entries,
		setParley(state) { parley = state; eventBus.emit("parley:pending-round-changed:v1", { version: 1 }); },
		get workingVisible() { return workingVisible; }, get queries() { return queries; }, get renders() { return renders; },
		setDelivery(state, notify = true) {
			delivery = state;
			if (notify) eventBus.emit("pi-handoff-queue:changed:v1", { version: 1 });
		},
	};
}

for (const cwd of [`${process.env.HOME}/dev/project`, "/tmp/é 中文 #?%/$x' project", "/"]) {
	test(`cwd hyperlink preserves display and absolute target: ${cwd}`, () => {
		const f = fixture(cwd);
		const border = f.editor.render(120)[0];
		const [link] = [...border.matchAll(linkPattern)];
		assert.ok(link);
		assert.equal(decodeURIComponent(link[1].slice("pi-slim-copy:".length)), cwd);
		const display = cwd.startsWith(process.env.HOME) ? `~${cwd.slice(process.env.HOME.length)}` : cwd;
		assert.equal(link[2], display);
		assert.ok(stripTerminalSequences(border).includes(display));
		assert.equal(stripTerminalSequences(border), border.replace(linkPattern, "$2"));
		assert.equal(visibleWidth(border), 120);
	});
}

test("streaming keeps the link separate from spinner and never intercepts input", async () => {
	const f = fixture(`${process.env.HOME}/dev/project`);
	const idleLink = [...f.editor.render(100)[0].matchAll(linkPattern)][0][0];
	assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(f.editor)), CustomEditor.prototype);
	assert.deepEqual([...f.events.keys()], ["agent_start", "agent_settled", "session_shutdown", "session_start"]);
	f.events.get("agent_start")();
	try {
		const border = f.editor.render(100)[0];
		assert.ok(border.includes("⠋"));
		assert.equal([...border.matchAll(linkPattern)][0][0], idleLink);
		const linkColumn = visibleWidth(border.slice(0, border.indexOf(idleLink)));
		assert.equal(getOsc8LinkAtColumn(border, linkColumn - 1), undefined);
		assert.equal(getOsc8LinkAtColumn(border, linkColumn), `pi-slim-copy:${encodeURIComponent(f.ctx.cwd)}`);
		assert.equal(getOsc8LinkAtColumn(border, visibleWidth(stripTerminalSequences(idleLink)) + linkColumn), undefined);
		f.editor.handleInput("hello");
		f.editor.handleInput("\x1b[200~ pasted text\x1b[201~");
		assert.equal(f.editor.getText(), "hello pasted text");
		assert.equal(f.terminal.rows, 40);
		assert.equal(Object.hasOwn(f.terminal, "rows"), false);
	} finally {
		f.events.get("agent_settled")();
		await f.commands.get("slim").handler("", f.ctx);
	}
	assert.equal(f.editor, undefined);
	assert.equal(f.workingVisible, true);
});

test("narrow borders preserve path targets without link leakage or excess width", () => {
	const f = fixture("/tmp/中文 long project");
	for (let width = 3; width <= 90; width++) {
		const border = f.editor.render(width)[0];
		assert.equal(visibleWidth(border), width);
		const links = [...border.matchAll(linkPattern)];
		assert.ok(links.length <= 1);
		assert.equal(border.replace(linkPattern, "$2").includes("\x1b]8"), false);
		if (links.length) {
			assert.ok(f.ctx.cwd.startsWith(links[0][2]));
			assert.equal(decodeURIComponent(links[0][1].slice("pi-slim-copy:".length)), f.ctx.cwd);
		}
	}
});

test("installed Kitty parses the rendered link without a window or clipboard access", (t) => {
	const f = fixture("/tmp/é 中文 #?%/$x' project");
	f.events.get("agent_start")();
	let border;
	try {
		border = f.editor.render(120)[0];
	} finally {
		f.events.get("agent_settled")();
	}
	const result = spawnSync("kitty", ["+runpy", `
import json, shlex, sys
from kitty.config import load_config
from kitty.constants import config_dir
from kitty.fast_data_types import Screen, set_options
from kitty.open_actions import actions_for_url_from_list, parse
set_options(load_config(config_dir + "/kitty.conf"))
screen = Screen(None, 4, 120, 100)
payload = json.load(sys.stdin)
data = payload["border"].encode("utf-8")
buffer = screen.test_create_write_buffer()
buffer[:len(data)] = data
screen.test_commit_write_buffer(buffer, data)
screen.test_parse_written_data()
links = list(screen.hyperlinks_as_set())
url = links[0][0].split(":", 1)[1]
actions = list(actions_for_url_from_list(url, parse([
    "protocol pi-slim-copy",
    "action launch --type=background python3 " + shlex.quote(payload["helper"]) + " $URL",
])))
print(json.dumps({"links": links, "cells": screen.line(0).hyperlink_ids(),
                  "text": str(screen.line(0)), "route": list(actions[0].args)}))
`], { input: JSON.stringify({ border, helper: fileURLToPath(new URL("./copy-path.py", import.meta.url)) }), encoding: "utf8" });
	if (result.error?.code === "ENOENT") return t.skip("Kitty is not installed");
	assert.equal(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout);
	const uri = `pi-slim-copy:${encodeURIComponent(f.ctx.cwd)}`;
	assert.equal(parsed.links.length, 1);
	assert.equal(parsed.links[0][0], `:${uri}`);
	assert.equal(parsed.text, stripTerminalSequences(border));
	const linkColumn = visibleWidth(border.slice(0, border.indexOf("\x1b]8;;")));
	const endColumn = linkColumn + visibleWidth(f.ctx.cwd);
	assert.ok(parsed.cells.slice(linkColumn, endColumn).every((id) => id === parsed.links[0][1]));
	assert.ok([...parsed.cells.slice(0, linkColumn), ...parsed.cells.slice(endColumn)].every((id) => id === 0));
	assert.deepEqual(parsed.route, ["--type=background", "python3", fileURLToPath(new URL("./copy-path.py", import.meta.url)), uri]);
});

test("copy helper passes exact decoded cwd to xclip without shell evaluation or a trailing newline", () => {
	const paths = [process.env.HOME, "/", "/tmp/é 中文 #?%/$x' project"];
	const result = spawnSync("python3", ["-c", `
import json, runpy, subprocess, sys
from unittest.mock import patch
payload = json.load(sys.stdin)
for path, url in payload["cases"]:
    sys.argv = [payload["helper"], url]
    with patch("subprocess.run") as run:
        namespace = runpy.run_path(payload["helper"], run_name="__main__")
        run.assert_called_once_with(["xclip", "-selection", "clipboard"], input=path.encode("utf-8"), check=True)
for url in ("https://example.com", "pi-slim-copy:relative", "pi-slim-copy:%2Ftmp%00"):
    with patch("subprocess.run") as run:
        try:
            namespace["copy_path"](url)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid URL accepted")
        run.assert_not_called()
with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "xclip")):
    try:
        namespace["copy_path"]("pi-slim-copy:%2Ftmp")
    except subprocess.CalledProcessError:
        pass
    else:
        raise AssertionError("clipboard failure suppressed")
`], {
		input: JSON.stringify({
			helper: fileURLToPath(new URL("./copy-path.py", import.meta.url)),
			cases: paths.map((path) => [path, `pi-slim-copy:${encodeURIComponent(path)}`]),
		}),
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
});

const pendingHint = "Enter: send now · Alt+Enter: after these results";
function pendingDelivery(roundId = "round-1") {
	const target = { pid: process.pid, cwd: process.cwd(), session: "/tmp/pi-slim-test-session.jsonl" };
	return {
		available: true, target, phase: "ready", frozen: false, deferredCount: 0,
		pendingRound: { origin: target, taskId: "task-1", executionId: "execution-1", roundId, aggregateId: `aggregate-${roundId}` },
	};
}
const showsHint = (f) => f.editor.render(100).some((line) => stripTerminalSequences(line) === pendingHint);

test("pending state follows Inbox changes, not agent completion, without rendering-time polling", () => {
	const state = pendingDelivery();
	const calls = [];
	const f = fixture(process.cwd(), { delivery: state, nativeSubmit(options) { calls.push(options); } });
	let legacy = 0;
	f.editor.onAction("app.message.followUp", () => { legacy++; });
	const queries = f.queries;
	f.editor.render(100);
	f.editor.render(100);
	assert.equal(f.queries, queries);
	f.events.get("agent_start")();
	f.events.get("agent_settled")();
	f.editor.handleInput("\x1b\r");
	assert.equal(calls[0].submitContext.afterResults.roundId, "round-1");
	f.setDelivery({ ...state, deferredCount: 2 });
	f.editor.handleInput("\x1b\r");
	assert.equal(calls[1].submitContext.afterResults.roundId, "round-1");
	f.setDelivery({ ...state, pendingRound: null });
	f.editor.handleInput("\x1b\r");
	assert.equal(legacy, 1);
	f.setDelivery(pendingDelivery("round-2"));
	f.editor.handleInput("\x1b\r");
	assert.equal(calls[2].submitContext.afterResults.roundId, "round-2");
	f.events.get("session_shutdown")();
	f.editor.handleInput("\x1b\r");
	assert.equal(legacy, 2);
});

test("pending Alt+Enter passes native intent and a round snapshot with the editor receiver", () => {
	const calls = [];
	const state = pendingDelivery();
	const options = { submitIntent: "followUp", submitContext: { afterResults: state.pendingRound } };
	const f = fixture(process.cwd(), {
		delivery: state,
		nativeSubmit(options) { calls.push({ receiver: this, options }); },
	});
	f.editor.setText("independent work");
	f.editor.handleInput("\x1b\r");
	assert.deepEqual(calls, [{ receiver: f.editor, options }]);
	assert.notEqual(calls[0].options.submitContext.afterResults, state.pendingRound);
	assert.notEqual(calls[0].options.submitContext.afterResults.origin, state.pendingRound.origin);
	assert.equal(f.editor.getText(), "independent work");
	assert.equal(f.events.has("input"), false);
	f.editor.handleInput("\x1b[13;3u");
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].options, options);
});

test("each submission keeps its captured round across settlement, later rounds, and source mutation", () => {
	const state = pendingDelivery();
	const first = structuredClone(state.pendingRound);
	const second = pendingDelivery("round-2");
	const calls = [];
	const f = fixture(process.cwd(), {
		delivery: state,
		nativeSubmit(options) {
			calls.push(options);
			if (calls.length === 1) {
				state.pendingRound.origin.session = "/mutated/session.jsonl";
				state.pendingRound.roundId = "mutated-round";
				f.setDelivery({ ...state, pendingRound: null });
				f.setDelivery(second);
			}
		},
	});
	f.editor.handleInput("\x1b\r");
	assert.deepEqual(calls[0].submitContext, { afterResults: first });
	f.editor.handleInput("\x1b\r");
	assert.deepEqual(calls[1].submitContext, { afterResults: second.pendingRound });
	assert.deepEqual(calls[0].submitContext, { afterResults: first });
});

test("pending normal Enter keeps native text and paste expansion without followUp intent", () => {
	const f = fixture(process.cwd(), {
		delivery: pendingDelivery(),
		nativeSubmit(options) {
			assert.notEqual(options?.submitIntent, "followUp");
			assert.equal(typeof CustomEditor.prototype.submit, "function");
			return CustomEditor.prototype.submit.call(this, options);
		},
	});
	const submitted = [];
	f.editor.onSubmit = (...args) => submitted.push(args);
	const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	f.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
	f.editor.handleInput("\r");
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0][0], text);
	assert.notEqual(submitted[0][1]?.submitIntent, "followUp");
	assert.equal(submitted[0][1]?.submitContext, undefined);
	assert.equal(f.editor.getText(), "");
});

test("old runtime, unavailable state, and mismatched target retain legacy Alt+Enter", () => {
	const valid = pendingDelivery();
	const f = fixture(process.cwd(), { nativeSubmit() { assert.fail("inactive mode intercepted input"); } });
	let legacyCalls = 0;
	f.editor.onAction("app.message.followUp", () => { legacyCalls++; });
	const states = [
		undefined, { ...valid, available: false }, { ...valid, frozen: true },
		{ ...valid, phase: "onboarding" }, { ...valid, pendingRound: null }, { ...valid, deferredCount: undefined },
		{ ...valid, target: { ...valid.target, pid: process.pid + 1 } },
		{ ...valid, target: { ...valid.target, cwd: "/another/project" } },
		{ ...valid, target: { ...valid.target, session: "/another/session.jsonl" } },
	];
	for (const state of states) {
		f.setDelivery(state);
		assert.equal(showsHint(f), false);
		f.editor.handleInput("\x1b\r");
	}
	assert.equal(legacyCalls, states.length);
	f.editor.submit = undefined;
	f.setDelivery(valid);
	assert.equal(showsHint(f), false);
	f.editor.handleInput("\x1b\r");
	assert.equal(legacyCalls, states.length + 1);
});

test("Alt+Enter requeries Inbox before dispatch and honors disableSubmit", () => {
	let submitted = 0;
	let legacy = 0;
	const state = pendingDelivery();
	const f = fixture(process.cwd(), { delivery: state, nativeSubmit() { submitted++; } });
	f.editor.onAction("app.message.followUp", () => { legacy++; });
	f.editor.setText("retained text");
	f.editor.disableSubmit = true;
	f.editor.handleInput("\x1b\r");
	assert.equal(submitted, 0);
	assert.equal(legacy, 0);
	assert.equal(f.editor.getText(), "retained text");
	f.editor.disableSubmit = false;
	f.setDelivery({ ...state, pendingRound: null }, false);
	f.editor.handleInput("\x1b\r");
	assert.equal(submitted, 0);
	assert.equal(legacy, 1);
});

test("pending and nonpending editors have identical compact rows without a hint", () => {
	const state = pendingDelivery();
	const f = fixture(process.cwd(), { nativeSubmit() {} });
	for (const text of ["", "one line", "first\nsecond\nthird"]) {
		f.editor.setText(text);
		for (const width of [10, 30, 100]) {
			f.setDelivery({ ...state, pendingRound: null });
			const normal = f.editor.render(width);
			f.setDelivery(state);
			const pending = f.editor.render(width);
			assert.deepEqual(pending, normal);
			assert.equal(pending.length, CustomEditor.prototype.render.call(f.editor, width).length - 1);
			assert.ok(pending.every((line) => visibleWidth(line) <= width));
			assert.equal(showsHint(f), false);
		}
	}
});

test("autocomplete rows remain intact with or without pending results", () => {
	const state = pendingDelivery();
	const f = fixture(process.cwd(), { nativeSubmit() {} });
	f.editor.autocompleteState = "prefix";
	f.editor.autocompleteList = { render: () => ["popup choice"] };
	const normal = f.editor.render(100);
	f.setDelivery(state);
	const pending = f.editor.render(100);
	assert.deepEqual(pending, normal);
	assert.equal(pending.length, CustomEditor.prototype.render.call(f.editor, 100).length);
	assert.equal(pending.at(-1).trim(), "popup choice");
	assert.equal(showsHint(f), false);
});

test("native submit contract smoke when the coordinated core build is available", (t) => {
	const state = pendingDelivery();
	const f = fixture(process.cwd(), { delivery: state });
	if (typeof f.editor.submit !== "function") return t.skip("coordinated core submit API is not built yet");
	const calls = [];
	const nativeSubmit = f.editor.submit;
	let submittedContext;
	f.editor.submit = function (options) {
		submittedContext = options.submitContext;
		return nativeSubmit.call(this, options);
	};
	f.editor.onSubmit = (text, options) => calls.push({ text, options });
	f.editor.handleInput("\x1b[200~deferred paste\x1b[201~");
	f.editor.handleInput("\x1b\r");
	assert.deepEqual(calls, [{
		text: "deferred paste",
		options: { submitIntent: "followUp", submitContext: { afterResults: state.pendingRound } },
	}]);
	assert.notEqual(calls[0].options.submitContext.afterResults, state.pendingRound);
	assert.equal(calls[0].options.submitContext, submittedContext);
	assert.equal(f.editor.getText(), "");
});

const stoppedAt = new Date(2026, 8, 16, 14, 37).getTime();
const stoppedEntry = () => ({ type: "custom", customType: "pi-slim.stopped", data: { at: stoppedAt } });
const statusLine = (f, width = 150) => stripTerminalSequences(f.editor.render(width)[0]);

test("last stopped time is local, restored, and unaffected by drafts or wake notifications", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: stoppedAt + 60000 });
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	assert.ok(statusLine(f).includes("16 Sep 14:37"));
	f.editor.handleInput("draft text");
	f.setParley({ handled: true, pendingRound: pendingDelivery().pendingRound, peers: [] });
	assert.ok(statusLine(f).includes("16 Sep 14:37 ───── waiting for wake"));
	assert.equal(f.entries.length, 1);
	f.events.get("agent_settled")();
	assert.equal(f.entries.length, 1);
	f.events.get("agent_start")();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	assert.ok(statusLine(f).includes("16 Sep 14:37"));
	t.mock.timers.tick(60000);
	f.events.get("agent_settled")();
	assert.ok(statusLine(f).includes("16 Sep 14:39 ───── waiting for wake"));
	assert.equal(f.entries.length, 2);
	const reopened = fixture(process.cwd(), { entries: f.entries });
	assert.ok(statusLine(reopened).includes("16 Sep 14:39"));
	assert.equal(f.entries.length, 2);
});

test("fresh panes do not invent a timestamp; persisted execution stops support older sessions", () => {
	const fresh = fixture(process.cwd());
	assert.equal(/\d{2} [A-Z][a-z]{2} \d{2}:\d{2}/.test(statusLine(fresh)), false);
	assert.equal(fresh.entries.length, 0);
	const restored = fixture(process.cwd(), { entries: [
		{ type: "custom", customType: "pi.execution.v1", timestamp: new Date(stoppedAt).toISOString(), data: { kind: "execution", status: "suspended" } },
		{ type: "message", timestamp: new Date(stoppedAt + 60000).toISOString(), message: { role: "user" } },
	] });
	assert.ok(statusLine(restored).includes("16 Sep 14:37"));
	assert.equal(restored.entries.length, 2);
});

test("Parley labels use actual peer state and clear on cancellation, processing or unknown state", () => {
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	const round = pendingDelivery().pendingRound;
	f.setParley({ handled: true, pendingRound: round, peers: [{ folder: "/home/sr/dev/pi/pi-notify" }, { folder: "/work/search", host: "laptop" }] });
	assert.ok(statusLine(f).includes("16 Sep 14:37 ───── parley with pi-notify laptop:search"));
	assert.equal(statusLine(f).includes("·"), false);
	f.events.get("agent_start")();
	assert.equal(statusLine(f).includes("parley with"), false);
	f.events.get("agent_settled")();
	assert.ok(statusLine(f).includes("parley with pi-notify laptop:search"));
	f.setParley({ handled: true, pendingRound: round, peers: [] });
	assert.ok(statusLine(f).includes("waiting for wake"));
	f.setParley({ handled: true, pendingRound: null, peers: [] });
	assert.equal(statusLine(f).includes("waiting"), false);
	f.setParley(undefined);
	assert.equal(statusLine(f).includes("parley with"), false);
});

test("timestamp and waiting status never add rows and narrow splits retain context/model", () => {
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	const normalHeight = f.editor.render(120).length;
	f.setParley({ handled: true, pendingRound: pendingDelivery().pendingRound, peers: [{ folder: "/work/pi-notify" }] });
	for (const width of [30, 50, 70, 120]) {
		const lines = f.editor.render(width);
		assert.equal(lines.length, normalHeight);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.ok(stripTerminalSequences(lines[0]).includes("12% 6k model"));
	}
	assert.ok(statusLine(f, 70).includes("16 Sep 14:37"));
});

const invalidateWakes = () => { for (const callback of wakeCallbacks) callback(); };
async function helperFixture() {
	const session = "/tmp/pi-slim-helper-fixture.jsonl";
	const backend = {
		calls: 0, validations: 0, known: true, live: true, pending: [{ run: "fixture-run", mode: "observe" }],
		async query(owner) {
			this.calls++;
			this.owner = owner;
			const snapshot = { owner, known: this.known, pending: this.pending };
			wakeProofs.set(snapshot, () => { this.validations++; return this.live; });
			return snapshot;
		},
	};
	wakeBackends.set(session, backend);
	const options = { session, entries: [stoppedEntry()] };
	const f = fixture(process.cwd(), options);
	await nextTurn();
	assert.equal(backend.calls, 1);
	return { f, backend, options };
}

test("helper status is owner-scoped, idle-only, compact, and does not advance the timestamp", async () => {
	const { f, backend } = await helperFixture();
	assert.deepEqual(backend.owner, { pid: process.pid, cwd: process.cwd(), session: f.ctx.sessionManager.getSessionFile() });
	const rows = f.editor.render(150).length;
	assert.ok(statusLine(f).includes("16 Sep 14:37 ───── waiting for wake"));
	assert.equal(f.entries.length, 1);
	f.editor.handleInput("draft");
	assert.ok(statusLine(f).includes("16 Sep 14:37"));
	const validations = backend.validations;
	f.events.get("agent_start")();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	assert.equal(backend.validations, validations);
	f.events.get("agent_settled")();
	await nextTurn();
	assert.ok(statusLine(f).includes("waiting for wake"));
	const stopped = f.entries.at(-1).data.at;
	backend.pending = [];
	invalidateWakes();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	assert.equal(f.entries.at(-1).data.at, stopped);
	backend.pending = [{ run: "launch-fixture", mode: "launch" }];
	invalidateWakes(); await nextTurn();
	assert.ok(statusLine(f).includes("waiting for wake"));
	assert.equal(f.entries.at(-1).data.at, stopped);
	assert.equal(f.editor.render(150).length, rows);
});

test("Parley names take precedence and helper custody loss hides on the next render without querying", async () => {
	const { f, backend } = await helperFixture();
	f.setParley({ handled: true, pendingRound: pendingDelivery().pendingRound, peers: [{ folder: "/work/pi-notify" }] });
	assert.ok(statusLine(f).includes("parley with pi-notify"));
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	f.setParley({ handled: true, pendingRound: null, peers: [] });
	assert.ok(statusLine(f).includes("waiting for wake"));
	const calls = backend.calls;
	backend.live = false;
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	assert.equal(backend.calls, calls);
	assert.equal(f.entries.length, 1);
});

test("unknown helper evidence, empty results, query failures and wrong owners never advertise waiting", async () => {
	const { f, backend } = await helperFixture();
	backend.known = false;
	invalidateWakes(); await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	backend.known = true; backend.pending = [];
	invalidateWakes(); await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	backend.query = async () => { throw new Error("unavailable"); };
	invalidateWakes(); await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	backend.query = async owner => {
		const snapshot = { owner: { ...owner, session: "/wrong.jsonl" }, known: true, pending: [{ run: "wrong", mode: "launch" }] };
		wakeProofs.set(snapshot, () => true);
		return snapshot;
	};
	invalidateWakes(); await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
});

test("helper invalidation bursts coalesce and never expose superseded query results", async () => {
	const { f, backend } = await helperFixture();
	const queries = [];
	backend.query = owner => new Promise(resolve => queries.push({ owner, resolve }));
	invalidateWakes(); invalidateWakes(); invalidateWakes();
	assert.equal(queries.length, 1);
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	const stale = { owner: queries[0].owner, known: true, pending: [{ run: "stale", mode: "observe" }] };
	wakeProofs.set(stale, () => true);
	queries[0].resolve(stale);
	await nextTurn();
	assert.equal(queries.length, 2);
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	queries[1].resolve({ owner: queries[1].owner, known: true, pending: [] });
	await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
});

test("session replacement discards late helper replies and disposes old lifecycle watchers", async () => {
	const { f, backend, options } = await helperFixture();
	assert.equal(wakeCallbacks.size, 1);
	let resolveOld;
	backend.query = owner => new Promise(resolve => { resolveOld = () => {
		const snapshot = { owner, known: true, pending: [{ run: "old", mode: "observe" }] };
		wakeProofs.set(snapshot, () => true); resolve(snapshot);
	}; });
	invalidateWakes();
	options.session = "/tmp/pi-slim-successor-fixture.jsonl";
	f.events.get("session_start")();
	await nextTurn();
	assert.equal(wakeCallbacks.size, 1);
	resolveOld(); await nextTurn();
	assert.equal(statusLine(f).includes("waiting for wake"), false);
	f.events.get("session_shutdown")();
	assert.equal(wakeCallbacks.size, 0);
	assert.equal(statusLine(f).includes("waiting for wake"), false);
});

test("non-TUI sessions do not query helper state or install filesystem watchers", async () => {
	const session = "/tmp/pi-slim-rpc-fixture.jsonl";
	let calls = 0;
	wakeBackends.set(session, { query() { calls++; throw new Error("unexpected helper query"); } });
	fixture(process.cwd(), { session, mode: "rpc" });
	await nextTurn();
	assert.equal(calls, 0);
	assert.equal(wakeCallbacks.size, 0);
});
