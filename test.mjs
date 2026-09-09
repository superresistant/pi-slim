import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import slim from "./index.ts";

const linkPattern = /\x1b\]8;;(pi-slim-copy:[^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g;

function fixture(cwd) {
	const events = new Map();
	const commands = new Map();
	const terminal = Object.create({ get rows() { return 40; } });
	const tui = { terminal, requestRender() {} };
	const theme = { borderColor: (text) => text, fg: (_color, text) => text };
	let editor;
	let workingVisible;
	const ctx = {
		cwd,
		model: { id: "model" },
		getContextUsage: () => ({ percent: 12, tokens: 6000 }),
		ui: {
			theme,
			setWorkingVisible: (visible) => { workingVisible = visible; },
			setFooter: (factory) => factory?.(tui, theme, {
				getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {},
			}),
			setEditorComponent: (factory) => { editor = factory?.(tui, theme, { matches: () => false }); },
			notify() {},
		},
	};
	slim({
		on: (event, handler) => events.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		getThinkingLevel: () => "off",
	});
	events.get("session_start")({}, ctx);
	return { get editor() { return editor; }, events, commands, ctx, terminal, get workingVisible() { return workingVisible; } };
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
	assert.equal(f.editor.handleInput, CustomEditor.prototype.handleInput);
	assert.deepEqual([...f.events.keys()], ["agent_start", "agent_end", "session_shutdown", "session_start"]);
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
		f.events.get("agent_end")();
		await f.commands.get("slim").handler("", f.ctx);
	}
	assert.equal(f.editor, undefined);
	assert.equal(f.workingVisible, true);
});

test("narrow borders drop whole path links without leakage or excess width", () => {
	const f = fixture("/tmp/中文 long project");
	for (let width = 3; width <= 90; width++) {
		const border = f.editor.render(width)[0];
		assert.equal(visibleWidth(border), width);
		const links = [...border.matchAll(linkPattern)];
		assert.ok(links.length <= 1);
		assert.equal(border.replace(linkPattern, "$2").includes("\x1b]8"), false);
		if (links.length) assert.equal(links[0][2], f.ctx.cwd);
	}
});

test("installed Kitty parses the rendered link without a window or clipboard access", (t) => {
	const f = fixture("/tmp/é 中文 #?%/$x' project");
	f.events.get("agent_start")();
	let border;
	try {
		border = f.editor.render(120)[0];
	} finally {
		f.events.get("agent_end")();
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
