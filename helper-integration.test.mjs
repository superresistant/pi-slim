import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Store } from "../agent-bus/store.ts";
import agentBus from "../agent-bus/extension.ts";
import slim from "./index.ts";

async function until(check) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await delay(25);
	}
	assert.fail("isolated consumer did not observe lifecycle change");
}

test("isolated agent-bus emits unresolved peer state consumed by slim without old backend probes", async (t) => {
	const folder = mkdtempSync(join(tmpdir(), "pi-slim-bus-integration-"));
	const db = join(folder, "bus.sqlite");
	const cwd = process.cwd();
	const session = join(folder, "fixture-session.jsonl");
	const env = { PI_BUS_DB: db, PI_BUS_TICK_MS: "25", PI_BUS_NO_NOTIFY: "1" };
	const before = Object.fromEntries(Object.keys({ ...env, PI_BUS_CWD: "", PI_BUS_SESSION: "" }).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const first = new Store(db);
	const ask = (id, peer) => first.send({ id, to_cwd: peer, from_cwd: cwd, from_session: session, kind: "ask", text: `question ${id}` });
	const a = ask("ask-a", "/work/pi-notify"), b = ask("ask-b", "/work/search"), c = ask("ask-c", "/work/pi-notify");
	first.close();
	const lifecycle = new Map(), events = new Map();
	const entries = [{ type: "custom", customType: "pi-slim.stopped", data: { at: new Date(2026, 8, 16, 14, 37).getTime() } }];
	let editor, renders = 0;
	const tui = { terminal: Object.create({ get rows() { return 40; } }), requestRender() { renders++; } };
	const theme = { borderColor: text => text, fg: (_color, text) => text };
	const ctx = {
		mode: "tui", cwd, model: { id: "model" }, isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => ({ percent: 12, tokens: 6000 }),
		sessionManager: { getSessionFile: () => session, getEntries: () => entries, getBranch: () => entries },
		ui: {
			theme, setWorkingVisible() {}, notify() {},
			setFooter: factory => factory?.(tui, theme, { getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {} }),
			setEditorComponent: factory => { editor = factory?.(tui, theme, { matches: () => false }); },
		},
	};
	const states = [];
	const pi = {
		events: { on: (name, fn) => { const handlers = events.get(name) ?? []; handlers.push(fn); events.set(name, handlers); },
			emit: (name, data) => { if (name === "agent-bus:state:v1") states.push(data); for (const fn of events.get(name) ?? []) fn(data); } },
		on: (name, fn) => { const handlers = lifecycle.get(name) ?? []; handlers.push(fn); lifecycle.set(name, handlers); },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		registerCommand() {}, getThinkingLevel: () => "off",
		sendMessage() { assert.fail("no bus delivery to this isolated recipient"); },
	};
	const fire = (name) => { for (const fn of lifecycle.get(name) ?? []) fn({}, ctx); };
	const line = () => stripTerminalSequences(editor.render(150)[0]);
	t.after(() => {
		fire("session_shutdown");
		for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
		rmSync(folder, { recursive: true, force: true });
	});
	agentBus(pi);
	slim(pi);
	fire("session_start");
	await until(() => line().includes("16/09 14:37─────parley with pi-notify search"));
	assert.deepEqual(states.at(-1).awaitingPeers, ["/work/pi-notify", "/work/search"]);
	assert.equal(states.at(-1).awaitingReplies, 3);
	assert.equal(editor.render(150).length, 2);
	const rendersBefore = renders;
	for (let i = 0; i < 20; i++) editor.render(150);
	assert.equal(renders, rendersBefore);
	const cli = fileURLToPath(new URL("../agent-bus/bin/bus", import.meta.url));
	const result = childProcess.spawnSync(cli, ["status"], { env: process.env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const store = new Store(db);
	const reply = (askId, id) => store.send({ id, to_cwd: "/work/reply-sink", from_cwd: "/work/pi-notify", kind: "reply", reply_to: askId, text: "done" });
	reply(a, "reply-a"); reply(c, "reply-c");
	await until(() => line().includes("parley with search") && !line().includes("pi-notify"));
	reply(b, "reply-b");
	await until(() => !line().includes("parley with"));
	store.close();
	assert.equal(entries.length, 1);
});

test("installed runtime fresh-starts an existing session in isolated narrow/wide PTYs", (t) => {
	const result = childProcess.spawnSync("kitty", ["+runpy", String.raw`
def main():
    import fcntl, json, os, pathlib, pty, select, struct, subprocess, sys, tempfile, termios, time
    from kitty.fast_data_types import Screen
    from urllib.parse import unquote
    payload = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="pi-slim-start-") as tmp:
        root = pathlib.Path(tmp)
        cwd = root / "long-parent-中文" / "gpu-operations"
        cwd.mkdir(parents=True)
        agent = root / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"quietStartup": True}))
        session = root / "session.jsonl"
        stopped = int(time.mktime((2026, 9, 23, 9, 50, 0, 0, 0, -1))) * 1000
        entries = [
            {"type": "session", "version": 3, "id": "slim-smoke", "timestamp": "2026-09-23T07:50:00Z", "cwd": str(cwd)},
            {"type": "custom", "id": "stopped", "parentId": None, "timestamp": "2026-09-23T07:50:00Z", "customType": "pi-slim.stopped", "data": {"at": stopped}},
        ]
        session.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
        env = dict(os.environ, TERM="xterm-256color", PI_CODING_AGENT_DIR=str(agent), PI_SKIP_VERSION_CHECK="1",
                   PI_BUS_DB=str(root / "bus.sqlite"), PI_BUS_NO_NOTIFY="1", TMPDIR=tmp)
        for width in [40, 120]:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, width, 0, 0))
            proc = subprocess.Popen(["node", payload["cli"], "--no-extensions", "-e", payload["extension"],
                                     "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
                                     "--provider", "openai", "--model", "gpt-4o", "--session", str(session)],
                                    cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            data = b""
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.1)[0]:
                        chunk = os.read(master, 65536)
                        data += chunk
                        if b"\x1b[6n" in chunk:
                            os.write(master, b"\x1b[1;1R")
                        if b"23/09 9:50" in data and b"pi-slim-copy:" in data:
                            break
                    assert proc.poll() is None, data.decode(errors="replace")
                assert b"23/09 9:50" in data and b"pi-slim-copy:" in data, data.decode(errors="replace")
                screen = Screen(None, 35, width, 100)
                buffer = screen.test_create_write_buffer()
                buffer[:len(data)] = data
                screen.test_commit_write_buffer(buffer, data)
                screen.test_parse_written_data()
                rows = [screen.line(i) for i in range(35)]
                status = [row for row in rows if "23/09 9:50" in str(row)]
                assert len(status) == 1, [str(row) for row in rows]
                assert "gpu-operations" in str(status[0]), str(status[0])
                assert "gpt-4o" in str(status[0]), str(status[0])
                assert "…/gpu-operations" in str(status[0]) if width == 40 else "long-parent-中文/gpu-operations" in str(status[0])
                assert any(status[0].hyperlink_ids())
                links = list(screen.hyperlinks_as_set())
                assert any(unquote(link[0].removeprefix(":pi-slim-copy:")) == str(cwd) for link in links)
                assert not any(label in str(status[0]) for label in ["last active", "working", " Sep "])
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                os.close(master)
        restored = [json.loads(line) for line in session.read_text().splitlines()]
        assert [entry["data"]["at"] for entry in restored if entry.get("customType") == "pi-slim.stopped"] == [stopped]
main()
`], {
		input: JSON.stringify({
			cli: fileURLToPath(new URL("../pi-local-runtime/packages/coding-agent/dist/bundle/cli.js", import.meta.url)),
			extension: fileURLToPath(new URL("./index.ts", import.meta.url)),
		}), encoding: "utf8", timeout: 45000,
	});
	if (result.error?.code === "ENOENT") return t.skip("Kitty is not installed");
	assert.equal(result.status, 0, result.stderr || String(result.error));
});
