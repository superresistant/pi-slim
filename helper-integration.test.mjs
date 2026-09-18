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
	const run = join(env.SUBAGENT_STATE_DIR, "runs", "a".repeat(32));
	mkdirSync(run, { recursive: true });
	const start = readFileSync(`/proc/${supervisor.pid}/stat`, "utf8").split(/\) /).at(-1).split(/\s+/)[19];
	save(join(run, "request.json"), { origin: owner, mode: "observe" });
	save(join(run, "supervisor.json"), { pid: supervisor.pid, start });
	save(join(run, "state.json"), { phase: "running", supervisorPid: supervisor.pid });
	save(join(run, "ready.json"), { pid: supervisor.pid });
	save(join(run, "caller-ready.json"), { markerWritten: true });
	save(join(run, "go.json"), { verifiedIdle: true });
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
	assert.ok(line().includes("16 Sep 14:37 ───── waiting for wake"));
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
	rmSync(join(run, "cancel.json"));
	await until(waiting);
	const beforeTerminal = renders;
	save(join(run, "state.json"), { phase: "terminal", supervisorPid: supervisor.pid });
	await until(() => renders > beforeTerminal && !waiting());
	save(join(run, "state.json"), { phase: "running", supervisorPid: supervisor.pid });
	await until(waiting);
	const beforeDeath = pings;
	const exit = once(supervisor, "exit"); supervisor.kill("SIGKILL"); await exit;
	assert.equal(waiting(), false);
	assert.equal(pings, beforeDeath);
	assert.ok(subprocesses.every(fn => fn.mock.callCount() === 0));
	assert.equal(entries.length, 1);
	assert.ok(line().includes("16 Sep 14:37"));
	assert.equal(editor.render(150).length, 2);
});
