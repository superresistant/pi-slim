import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { getOsc8LinkAtColumn, matchesKey, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const cacheCalls = [];
let cachePredict = () => ({ probability: null, samples: 0, account: "", lastRequestAt: null, reason: "empty" });
globalThis.__piSlimCacheFixture = (options) => { cacheCalls.push(options); return cachePredict(options); };
const shutdowns = new Set();
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent" && context.parentURL?.endsWith("/pi-slim-bus-prep/index.ts")) {
		const sdk = nextResolve(specifier, context);
		const source = `export * from ${JSON.stringify(sdk.url)}; export const getCachePrediction = globalThis.__piSlimCacheFixture;`;
		return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
	}
	return nextResolve(specifier, context);
} });
const { default: slim } = await import("./index.ts");
afterEach(() => {
	for (const shutdown of shutdowns) shutdown();
	shutdowns.clear();
	cacheCalls.length = 0;
	cachePredict = () => ({ probability: null, samples: 0, account: "", lastRequestAt: null, reason: "empty" });
});

const linkPattern = /\x1b\]8;;(pi-slim-copy:[^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g;

function fixture(cwd, options = {}) {
	const events = new Map();
	const bus = new Map();
	const commands = new Map();
	const entries = options.entries ?? [];
	let renders = 0;
	const eventBus = {
		on: (name, handler) => bus.set(name, handler),
		emit(name, request) { bus.get(name)?.(request); },
	};
	const terminal = Object.create({ get rows() { return 40; } });
	const tui = { terminal, requestRender() { renders++; } };
	const theme = options.theme ?? { borderColor: (text) => text, fg: (_color, text) => text };
	let editor;
	let workingVisible;
	const ctx = {
		cwd,
		mode: options.mode ?? "tui",
		model: { id: options.model ?? "model", provider: options.provider },
		modelRegistry: options.accountLookup ? { getCodexAccountId: options.accountLookup } : {},
		getContextUsage: () => ({ percent: 12, tokens: 6000 }),
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => options.session ?? "/tmp/pi-slim-test-session.jsonl",
			getSessionId: () => options.sessionId ?? "00000000-0000-4000-8000-000000000001",
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
		getThinkingLevel: () => options.thinking ?? "off",
	});
	events.get("session_start")({}, ctx);
	shutdowns.add(() => events.get("session_shutdown")());
	return {
		get editor() { return editor; }, events, commands, ctx, terminal, entries, eventBus,
		setBus(state = {}) {
			eventBus.emit("agent-bus:state:v1", {
				pid: process.pid, cwd: realpathSync(cwd), session: ctx.sessionManager.getSessionFile(),
				accepting: true, pending: 0, awaitingReplies: 0, awaitingPeers: [],
				handoff: "", autopilot: "", ...state,
			});
		},
		get workingVisible() { return workingVisible; }, get renders() { return renders; },
	};
}

for (const cwd of [process.env.HOME, `${process.env.HOME}/dev/project`, `${process.env.HOME}-other/project`, "/tmp/é 中文 #?%/$x' project", "/"]) {
	test(`cwd hyperlink preserves display and absolute target: ${cwd}`, () => {
		const f = fixture(cwd);
		const border = f.editor.render(120)[0];
		const [link] = [...border.matchAll(linkPattern)];
		assert.ok(link);
		assert.equal(decodeURIComponent(link[1].slice("pi-slim-copy:".length)), cwd);
		const display = cwd === process.env.HOME || cwd.startsWith(`${process.env.HOME}/`) ? `~${cwd.slice(process.env.HOME.length)}` : cwd;
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
	assert.deepEqual([...f.events.keys()], ["agent_start", "agent_settled", "model_select", "session_tree", "session_compact", "session_shutdown", "session_start"]);
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
			assert.ok(links[0][2].length > 0);
			assert.equal(decodeURIComponent(links[0][1].slice("pi-slim-copy:".length)), f.ctx.cwd);
		}
	}
});

test("narrow layout keeps the identifying tail, drops thinking then tokens, and only finally clips basename", () => {
	const cwd = `${process.env.HOME}/dev/vaiata-inference/agents/gpu-operations`;
	const f = fixture(cwd, { thinking: "high", model: "gpt-6-sol" });
	assert.equal(statusLine(fixture(`${cwd}/`), 14), "gpu-operations");
	assert.ok(statusLine(f, 120).includes("~/dev/vaiata-inference/agents/gpu-operations"));
	assert.ok(statusLine(f, 120).includes("12% 6k gpt6sol high"));
	for (const [id, display] of [
		["gpt-6-sol-mini", "gpt6solmini"],
		["claude-opus-4-6", "claudeopus46"],
		["model", "model"],
	]) {
		const modelFixture = fixture(cwd, { model: id });
		assert.ok(statusLine(modelFixture, 120).includes(display));
		assert.equal(modelFixture.ctx.model.id, id);
	}
	const contextPrefixWidth = statusLine(f, 120).includes("ctx ") ? 4 : 0;
	assert.ok(statusLine(f, 40 + contextPrefixWidth).startsWith("…/gpu-operations"));
	assert.ok(statusLine(f, 33 + contextPrefixWidth).includes("12% 6k gpt6sol"));
	assert.equal(statusLine(f, 33 + contextPrefixWidth).includes("high"), false);
	assert.ok(statusLine(f, 28 + contextPrefixWidth).includes("gpu-operations"));
	assert.ok(statusLine(f, 28 + contextPrefixWidth).includes("12% gpt6sol"));
	assert.equal(statusLine(f, 28 + contextPrefixWidth).includes("6k"), false);
	assert.ok(statusLine(f, 26).includes("gpu-operations"));
	assert.ok(statusLine(f, 26).includes("gpt6sol"));
	assert.equal(statusLine(f, 26).includes("12%"), false);
	assert.equal(statusLine(f, 14), "gpu-operations");
	assert.equal(statusLine(f, 10), "gpu-opera…");
	for (const width of [10, 14, 26, 30, 36, 40, 120]) {
		const row = f.editor.render(width)[0];
		assert.equal(visibleWidth(row), width);
		assert.equal(getOsc8LinkAtColumn(row, 0), `pi-slim-copy:${encodeURIComponent(cwd)}`);
	}
});

test("Unicode/ANSI narrow and wide rows retain basename and close copy links before status", () => {
	const theme = { borderColor: text => `\x1b[35m${text}\x1b[39m`, fg: (_color, text) => `\x1b[90m${text}\x1b[39m` };
	for (const name of ["中文-gpu", "e\u0301quipe-🧑‍💻", "🚀-operations"]) {
		const cwd = `/tmp/long-parent/another-parent/${name}`;
		const f = fixture(cwd, { thinking: "high", theme });
		for (const working of [false, true]) {
			if (working) f.events.get("agent_start")();
			for (let width = 2; width <= 120; width++) {
				const lines = f.editor.render(width);
				assert.equal(lines.length, 2);
				assert.equal(visibleWidth(lines[0]), width);
				const display = stripTerminalSequences(lines[0]);
				if (width >= visibleWidth(name) + Number(working)) assert.ok(display.includes(name), `${width}: ${display}`);
				for (let col = 0; col < width; col++) {
					const link = getOsc8LinkAtColumn(lines[0], col);
					if (link) assert.equal(link, `pi-slim-copy:${encodeURIComponent(cwd)}`);
				}
				const rule = display.indexOf("─");
				if (rule >= 0) assert.equal(getOsc8LinkAtColumn(lines[0], visibleWidth(display.slice(0, rule))), undefined);
				if (working) assert.equal(getOsc8LinkAtColumn(lines[0], 0), undefined);
			}
			if (working) f.events.get("agent_settled")();
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

test("Alt+Enter stays native without a dependency or hidden status row", () => {
	const f = fixture(process.cwd());
	let followed = 0;
	f.editor.onAction("app.message.followUp", () => { followed++; });
	f.editor.handleInput("\x1b\r");
	assert.equal(followed, 1);
	const submitted = [];
	f.editor.onSubmit = (...args) => submitted.push(args);
	f.editor.handleInput("\x1b[200~native paste\x1b[201~");
	f.editor.handleInput("\r");
	assert.equal(submitted[0][0], "native paste");
	assert.equal(submitted[0][1]?.submitContext, undefined);
	assert.equal(f.editor.render(100).length, 2);
});

test("bus state shows unresolved peers only for the exact active owner, without render probes", () => {
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	const initialRows = f.editor.render(120).length;
	const original = statusLine(f);
	f.setBus({ awaitingReplies: 3, awaitingPeers: ["/work/pi-notify", "/work/search", "/work/pi-notify"], pending: 2 });
	assert.ok(statusLine(f).includes("16/09 14:37─────parley with pi-notify search"));
	assert.equal(f.editor.render(120).length, initialRows);
	const renders = f.renders;
	for (let i = 0; i < 20; i++) statusLine(f);
	assert.equal(f.renders, renders);
	for (const owner of [{ pid: process.pid + 1 }, { cwd: "/elsewhere" }, { session: "/elsewhere.jsonl" }]) {
		f.setBus({ ...owner, awaitingReplies: 0, awaitingPeers: [] });
		assert.ok(statusLine(f).includes("parley with pi-notify search"));
	}
	f.events.get("agent_start")();
	assert.equal(statusLine(f).includes("parley with"), false);
	f.events.get("agent_settled")();
	assert.ok(statusLine(f).includes("parley with pi-notify search"));
	f.setBus({ awaitingReplies: 1, awaitingPeers: [] });
	assert.ok(statusLine(f).includes("waiting for reply"));
	f.setBus({ pending: 2, awaitingPeers: ["/work/stale"] });
	assert.equal(statusLine(f).includes("waiting"), false);
	assert.equal(statusLine(f).includes("parley with"), false);
	assert.equal(f.entries[0].data.at, stoppedAt);
	assert.notEqual(statusLine(f), original);
});

test("session replacement and shutdown discard stale bus state", () => {
	const options = { session: "/tmp/bus-slim-first.jsonl" };
	const f = fixture(process.cwd(), options);
	f.setBus({ awaitingReplies: 1, awaitingPeers: ["/work/old-peer"] });
	assert.ok(statusLine(f).includes("parley with old-peer"));
	options.session = "/tmp/bus-slim-second.jsonl";
	f.events.get("session_start")();
	assert.equal(statusLine(f).includes("old-peer"), false);
	f.setBus({ session: "/tmp/bus-slim-first.jsonl", awaitingReplies: 1, awaitingPeers: ["/work/old-peer"] });
	assert.equal(statusLine(f).includes("old-peer"), false);
	f.setBus({ awaitingReplies: 1, awaitingPeers: ["/work/new-peer"] });
	assert.ok(statusLine(f).includes("new-peer"));
	f.events.get("session_shutdown")();
	f.setBus({ awaitingReplies: 1, awaitingPeers: ["/work/late-peer"] });
	assert.equal(statusLine(f).includes("late-peer"), false);
});

async function waitForCache(f, label) {
	for (let i = 0; i < 60 && !statusLine(f).includes(label); i++) await nextTurn();
	assert.ok(statusLine(f).includes(label), statusLine(f));
}

test("Codex cache probability uses the selected account and no render probes", async () => {
	let account = "login-A", lookups = 0;
	const f = fixture(`${process.env.HOME}/dev/long-project/gpu-operations`, {
		provider: "openai-codex", model: "gpt-6-sol", accountLookup: async () => { lookups++; return account; },
	});
	cachePredict = ({ accountId }) => ({ probability: accountId === "login-A" ? .94 : .31, samples: 7, account: accountId, lastRequestAt: Date.now(), reason: "warm" });
	await waitForCache(f, "c94%");
	assert.deepEqual(cacheCalls.at(-1), { sessionId: "00000000-0000-4000-8000-000000000001", model: "gpt-6-sol", accountId: "login-A" });
	const initialLookups = lookups, initialProbes = cacheCalls.length;
	for (let i = 0; i < 30; i++) f.editor.render(45);
	assert.equal(lookups, initialLookups);
	assert.equal(cacheCalls.length, initialProbes);
	account = "login-B";
	f.events.get("agent_settled")();
	assert.equal(statusLine(f).includes("c94%"), false);
	await waitForCache(f, "c31%");
	assert.equal(cacheCalls.at(-1).accountId, "login-B");
	for (const width of [36, 42, 120]) {
		const line = f.editor.render(width)[0];
		assert.equal(visibleWidth(line), width);
		assert.equal(getOsc8LinkAtColumn(line, 0), `pi-slim-copy:${encodeURIComponent(f.ctx.cwd)}`);
		assert.ok(stripTerminalSequences(line).includes("gpu-operations"));
		assert.ok(stripTerminalSequences(line).includes("gpt6sol"));
	}
	assert.equal(statusLine(f, 27).includes("c31%"), false);
	assert.ok(statusLine(f, 120).includes("c31%"));
});

test("tree and compaction invalidate the previous request seed until a later recorded request", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 23, 13, 0).getTime() });
	let lastRequestAt = Date.now() - 1000;
	const f = fixture(process.cwd(), { provider: "openai-codex", accountLookup: async () => "login-A" });
	cachePredict = () => ({ probability: .94, samples: 40, account: "login-A", lastRequestAt, reason: "warm" });
	await waitForCache(f, "c94%");
	for (const event of ["session_tree", "session_compact"]) {
		f.events.get(event)();
		await nextTurn();
		assert.ok(statusLine(f).includes("c?"));
		assert.equal(statusLine(f).includes("c94%"), false);
		f.events.get("agent_settled")();
		await nextTurn();
		assert.equal(statusLine(f).includes("c94%"), false);
		t.mock.timers.tick(1000);
		lastRequestAt = Date.now();
		f.events.get("agent_settled")();
		await waitForCache(f, "c94%");
	}
});

test("session replacement switches prediction scope and disposes the previous timer", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const options = { provider: "openai-codex", sessionId: "first-session", accountLookup: async () => "login-A" };
	cachePredict = ({ sessionId }) => ({ probability: sessionId === "first-session" ? .94 : .52, samples: 30, account: "login-A", lastRequestAt: null, reason: "warm" });
	const f = fixture(process.cwd(), options);
	await waitForCache(f, "c94%");
	options.sessionId = "second-session";
	f.events.get("session_start")();
	await waitForCache(f, "c52%");
	assert.equal(cacheCalls.at(-1).sessionId, "second-session");
	const before = cacheCalls.length;
	t.mock.timers.tick(299_999);
	await nextTurn();
	assert.equal(cacheCalls.length, before);
	t.mock.timers.tick(1);
	await nextTurn();
	assert.equal(cacheCalls.length, before + 1);
	assert.equal(cacheCalls.at(-1).sessionId, "second-session");
});

test("unsupported credentials and models show unavailable without guessing an account", async () => {
	const codex = fixture(process.cwd(), { provider: "openai-codex", accountLookup: async () => undefined });
	await nextTurn();
	assert.ok(statusLine(codex).includes("c?"));
	assert.equal(cacheCalls.length, 0);
	const oldSdk = fixture(process.cwd(), { provider: "openai-codex" });
	assert.ok(statusLine(oldSdk).includes("c?"));
	const sparse = fixture(process.cwd(), { provider: "openai-codex", accountLookup: async () => "login-C" });
	await nextTurn();
	assert.ok(statusLine(sparse).includes("c?"));
	assert.equal(statusLine(sparse).includes("c0%"), false);
	assert.equal(cacheCalls.at(-1).accountId, "login-C");
	const beforeOther = cacheCalls.length;
	const headless = fixture(process.cwd(), { mode: "print", provider: "openai-codex", accountLookup: () => { assert.fail("non-TUI account lookup"); } });
	assert.equal(statusLine(headless).includes("c?"), false);
	const other = fixture(process.cwd(), { provider: "anthropic", accountLookup: () => { assert.fail("unexpected account lookup"); } });
	assert.equal(statusLine(other).includes("c?"), false);
	assert.equal(cacheCalls.length, beforeOther);
});

test("cache lifecycle ignores stale account replies, changes model, polls every five minutes and stops on shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let release;
	let account = "login-A";
	const f = fixture(process.cwd(), { provider: "openai-codex", model: "gpt-6-sol", accountLookup: () =>
		account === "pending" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(account),
	});
	cachePredict = ({ accountId }) => ({ probability: accountId === "login-A" ? .94 : .23, samples: 5, account: accountId, lastRequestAt: null, reason: "warm" });
	await waitForCache(f, "c94%");
	account = "pending";
	f.events.get("model_select")();
	assert.equal(statusLine(f).includes("c94%"), false);
	account = "login-B";
	f.ctx.model.id = "gpt-6-mini";
	f.events.get("model_select")();
	await waitForCache(f, "c23%");
	release("login-A");
	await nextTurn();
	assert.equal(statusLine(f).includes("c94%"), false);
	assert.equal(cacheCalls.at(-1).model, "gpt-6-mini");
	const initial = cacheCalls.length;
	account = "login-A";
	t.mock.timers.tick(299_999);
	await nextTurn();
	assert.equal(cacheCalls.length, initial);
	t.mock.timers.tick(1);
	await waitForCache(f, "c94%");
	assert.equal(cacheCalls.length, initial + 1);
	assert.equal(cacheCalls.at(-1).accountId, "login-A");
	f.events.get("session_shutdown")();
	const stopped = cacheCalls.length;
	t.mock.timers.tick(600_000);
	await nextTurn();
	assert.equal(cacheCalls.length, stopped);
});

const stoppedAt = new Date(2026, 8, 16, 14, 37).getTime();
const stoppedEntry = () => ({ type: "custom", customType: "pi-slim.stopped", data: { at: stoppedAt } });
const statusLine = (f, width = 150) => stripTerminalSequences(f.editor.render(width)[0]);

test("stopped time uses local DD/MM H:mm: padded day/month/minute, unpadded 24-hour hour", () => {
	for (const [date, expected] of [
		[new Date(2026, 8, 23, 9, 50), "23/09 9:50"],
		[new Date(2026, 0, 2, 0, 5), "02/01 0:05"],
		[new Date(2026, 10, 3, 23, 9), "03/11 23:09"],
	]) {
		const f = fixture(process.cwd(), { entries: [{ type: "custom", customType: "pi-slim.stopped", data: { at: date.getTime() } }] });
		assert.ok(statusLine(f).includes(expected));
	}
});

test("last stopped time is local, restored, and unaffected by drafts or bus state", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: stoppedAt + 60000 });
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	assert.ok(statusLine(f).includes("16/09 14:37"));
	f.editor.handleInput("draft text");
	f.setBus({ awaitingReplies: 1, awaitingPeers: [] });
	assert.ok(statusLine(f).includes("16/09 14:37─────waiting for reply"));
	assert.equal(f.entries.length, 1);
	f.events.get("agent_settled")();
	assert.equal(f.entries.length, 1);
	f.events.get("agent_start")();
	assert.equal(statusLine(f).includes("waiting for reply"), false);
	assert.ok(statusLine(f).includes("16/09 14:37"));
	t.mock.timers.tick(60000);
	f.events.get("agent_settled")();
	assert.ok(statusLine(f).includes("16/09 14:39─────waiting for reply"));
	assert.equal(f.entries.length, 2);
	const reopened = fixture(process.cwd(), { entries: f.entries });
	assert.ok(statusLine(reopened).includes("16/09 14:39"));
	assert.equal(f.entries.length, 2);
});

test("fresh panes do not invent a timestamp; persisted execution stops support older sessions", () => {
	const fresh = fixture(process.cwd());
	assert.equal(/\d{2}\/\d{2} \d{1,2}:\d{2}/.test(statusLine(fresh)), false);
	assert.equal(fresh.entries.length, 0);
	const restored = fixture(process.cwd(), { entries: [
		{ type: "custom", customType: "pi.execution.v1", timestamp: new Date(stoppedAt).toISOString(), data: { kind: "execution", status: "suspended" } },
		{ type: "message", timestamp: new Date(stoppedAt + 60000).toISOString(), message: { role: "user" } },
	] });
	assert.ok(statusLine(restored).includes("16/09 14:37"));
	assert.equal(restored.entries.length, 2);
});

test("bus peer labels clear on replies and stay hidden while working", () => {
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	f.setBus({ awaitingReplies: 2, awaitingPeers: ["/home/sr/dev/pi/pi-notify", "/work/search"] });
	assert.ok(statusLine(f).includes("16/09 14:37─────parley with pi-notify search"));
	assert.equal(statusLine(f).includes("·"), false);
	f.events.get("agent_start")();
	assert.equal(statusLine(f).includes("parley with"), false);
	f.events.get("agent_settled")();
	assert.ok(statusLine(f).includes("parley with pi-notify search"));
	f.setBus();
	assert.equal(statusLine(f).includes("waiting"), false);
});

test("all status separator strokes stay muted regardless of thinking border color", (t) => {
	const frames = [];
	const theme = {
		borderColor: text => `\x1b[35m${text}\x1b[39m`,
		fg: (color, text) => `\x1b[${color === "muted" ? 90 : 36}m${text}\x1b[39m`,
	};
	const f = fixture(process.cwd(), { entries: [stoppedEntry()], theme });
	for (const border of [37, 35]) {
		f.editor.borderColor = text => `\x1b[${border}m${text}\x1b[39m`;
		for (const waiting of [false, true]) {
			f.setBus(waiting ? { awaitingReplies: 1, awaitingPeers: ["/work/pi-notify"] } : {});
			for (const width of [40, 150]) {
				const lines = f.editor.render(width);
				let color, strokes = 0;
				for (const match of lines[0].matchAll(/\x1b\[(\d+)m|─/g)) {
					if (match[1]) color = Number(match[1]);
					else { assert.equal(color, 90); strokes++; }
				}
				assert.ok(strokes > 0);
				assert.equal(visibleWidth(lines[0]), width);
				assert.equal(lines.length, 2);
				if (waiting && width === 150) {
					assert.ok(lines[0].includes("\x1b[90m─────\x1b[39m"));
					frames.push(lines[0]);
				}
			}
		}
	}
	const result = spawnSync("kitty", ["+runpy", `
import json, sys
from kitty.fast_data_types import Screen
for line in json.load(sys.stdin):
    screen = Screen(None, 3, 200, 100)
    data = (line + "\\r\\n\\x1b[90mR").encode("utf-8")
    buffer = screen.test_create_write_buffer()
    buffer[:len(data)] = data
    screen.test_commit_write_buffer(buffer, data)
    screen.test_parse_written_data()
    expected = screen.line(1).cursor_from(0).fg
    row = screen.line(0)
    strokes = [i for i, char in enumerate(str(row)) if char == "─"]
    assert strokes
    assert all(row.cursor_from(i).fg == expected for i in strokes)
`], { input: JSON.stringify(frames), encoding: "utf8" });
	if (result.error?.code === "ENOENT") return t.skip("Kitty is not installed");
	assert.equal(result.status, 0, result.stderr);
});

test("timestamp and waiting status never add rows and narrow splits retain folder/model", () => {
	const f = fixture(process.cwd(), { entries: [stoppedEntry()] });
	const normalHeight = f.editor.render(120).length;
	f.setBus({ awaitingReplies: 1, awaitingPeers: ["/work/pi-notify"] });
	for (const width of [30, 50, 70, 120]) {
		const lines = f.editor.render(width);
		assert.equal(lines.length, normalHeight);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.ok(stripTerminalSequences(lines[0]).includes("pi-slim"));
		assert.ok(stripTerminalSequences(lines[0]).includes("model"));
	}
	assert.ok(statusLine(f, 70).includes("16/09 14:37"));
});

test("non-TUI ignores bus status without querying the bus or adding rows", () => {
	const f = fixture(process.cwd(), { mode: "rpc" });
	const rows = f.editor.render(100).length;
	f.setBus({ awaitingReplies: 1, awaitingPeers: ["/work/peer"] });
	assert.equal(f.editor.render(100).length, rows);
	assert.equal(statusLine(f).includes("parley with"), false);
});
