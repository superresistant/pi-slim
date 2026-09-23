import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Inbox } from "../pi-handoff-queue/inbox-store.ts";

const save = (file, value) => writeFileSync(file, JSON.stringify(value));
async function until(check) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await delay(25);
	}
	assert.fail("isolated consumer did not observe lifecycle change");
}

test("installed slim consumes local helper adapter using isolated Unix control, storage and Inbox", async (t) => {
	const installed = join(homedir(), ".pi/agent/extensions/pi-slim.ts");
	assert.equal(realpathSync(installed), realpathSync(fileURLToPath(new URL("./index.ts", import.meta.url))));
	const folder = mkdtempSync(join(tmpdir(), "pi-slim-helper-integration-"));
	const env = {
		SUBAGENT_STATE_DIR: join(folder, "state"), PI_HANDOFF_INBOX_DB: join(folder, "inbox.sqlite"),
		TMPDIR: folder, SUBAGENT_PI_CTL: join(folder, "no-shell-control"),
	};
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const events = new Map(), bus = new Map();
	let inbox, supervisor, control;
	let pings = 0;
	t.after(async () => {
		events.get("session_shutdown")?.();
		if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
			const exit = once(supervisor, "exit"); supervisor.kill(); await exit;
		}
		if (control) await new Promise(resolve => control.close(resolve));
		inbox?.close();
		for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
		rmSync(folder, { recursive: true, force: true });
	});
	mkdirSync(env.SUBAGENT_STATE_DIR);
	const owner = { pid: process.pid, cwd: process.cwd(), session: join(folder, "fixture-session.jsonl") };
	inbox = new Inbox(env.PI_HANDOFF_INBOX_DB);
	inbox.register(owner);
	const controlDir = join(folder, `pi-ctl-${process.getuid()}`);
	mkdirSync(controlDir);
	control = createServer(socket => {
		let input = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			input += chunk;
			if (!input.includes("\n")) return;
			assert.equal(JSON.parse(input.trim()).cmd, "ping");
			pings++;
			socket.end(JSON.stringify({ ok: true, ...owner, inbox: { available: true, frozen: false, target: owner } }) + "\n");
		});
	});
	control.listen(join(controlDir, `${owner.pid}.sock`));
	await once(control, "listening");
	supervisor = spawn("/bin/sleep", ["30"]);
	const start = readFileSync(`/proc/${supervisor.pid}/stat`, "utf8").split(/\) /).at(-1).split(/\s+/)[19];
	const addRun = (id) => {
		const path = join(env.SUBAGENT_STATE_DIR, "runs", id);
		mkdirSync(path, { recursive: true });
		save(join(path, "request.json"), { origin: owner, mode: "observe" });
		save(join(path, "supervisor.json"), { pid: supervisor.pid, start });
		save(join(path, "state.json"), { phase: "running", supervisorPid: supervisor.pid });
		save(join(path, "ready.json"), { pid: supervisor.pid });
		save(join(path, "caller-ready.json"), { markerWritten: true });
		save(join(path, "go.json"), { verifiedIdle: true });
		return path;
	};
	let run = addRun("a".repeat(32));
	const entries = [{ type: "custom", customType: "pi-slim.stopped", data: { at: new Date(2026, 8, 16, 14, 37).getTime() } }];
	let editor, renders = 0;
	const terminal = Object.create({ get rows() { return 40; } });
	const tui = { terminal, requestRender() { renders++; } };
	const theme = { borderColor: text => text, fg: (_color, text) => text };
	const ctx = {
		mode: "tui", cwd: owner.cwd, model: { id: "model" }, isIdle: () => true,
		getContextUsage: () => ({ percent: 12, tokens: 6000 }),
		sessionManager: { getSessionFile: () => owner.session, getEntries: () => entries, getEntry: () => undefined },
		ui: {
			theme, setWorkingVisible() {}, notify() {},
			setFooter: factory => factory?.(tui, theme, { getExtensionStatuses: () => new Map(), getGitBranch: () => null, onBranchChange: () => () => {} }),
			setEditorComponent: factory => { editor = factory?.(tui, theme, { matches: () => false }); },
		},
	};
	const subprocesses = ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync", "fork"].map(name =>
		t.mock.method(childProcess, name, () => { throw new Error("wake adapter subprocess forbidden in this fixture"); }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const { default: slim } = await import(pathToFileURL(installed).href);
	slim({
		events: { on: (name, fn) => bus.set(name, fn), emit: (name, data) => bus.get(name)?.(data) },
		on: (name, fn) => events.set(name, (data = {}) => fn(data, ctx)),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		registerCommand() {}, getThinkingLevel: () => "off",
	});
	events.get("session_start")();
	const line = () => stripTerminalSequences(editor.render(150)[0]);
	const waiting = () => line().includes("waiting for wake");
	await until(() => {
		assert.ok(subprocesses.every(fn => fn.mock.callCount() === 0), "adapter upgrade required: subprocess attempt");
		return waiting();
	});
	assert.ok(line().includes("16/09 14:37─────waiting for wake"));
	assert.equal(editor.render(150).length, 2);
	const queries = pings;
	assert.ok(queries > 0);
	for (let i = 0; i < 10; i++) assert.equal(waiting(), true);
	assert.equal(pings, queries);
	const beforeUnrelated = renders;
	for (let i = 0; i < 10; i++) inbox.register({ ...owner, session: join(folder, `unrelated-${i}.jsonl`) });
	await delay(100);
	assert.equal(pings, queries);
	assert.equal(renders, beforeUnrelated);
	assert.equal(waiting(), true);
	editor.handleInput("draft");
	assert.equal(entries.length, 1);
	const beforeCancel = renders;
	save(join(run, "cancel.json"), { cancel: true });
	await until(() => renders > beforeCancel && !waiting());
	run = addRun("b".repeat(32));
	await until(waiting);
	const beforeTerminal = renders;
	save(join(run, "state.json"), { phase: "terminal", supervisorPid: supervisor.pid });
	await until(() => renders > beforeTerminal && !waiting());
	run = addRun("c".repeat(32));
	await until(waiting);
	const beforeDeath = pings;
	const exit = once(supervisor, "exit"); supervisor.kill("SIGKILL"); await exit;
	assert.equal(waiting(), false);
	assert.equal(pings, beforeDeath);
	assert.ok(subprocesses.every(fn => fn.mock.callCount() === 0));
	assert.equal(entries.length, 1);
	assert.ok(line().includes("16/09 14:37"));
	assert.equal(editor.render(150).length, 2);
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
                   SUBAGENT_STATE_DIR=str(root / "helpers"), PI_HANDOFF_INBOX_DB=str(root / "inbox.sqlite"), TMPDIR=tmp)
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
			extension: join(homedir(), ".pi/agent/extensions/pi-slim.ts"),
		}), encoding: "utf8", timeout: 45000,
	});
	if (result.error?.code === "ENOENT") return t.skip("Kitty is not installed");
	assert.equal(result.status, 0, result.stderr || String(result.error));
});
