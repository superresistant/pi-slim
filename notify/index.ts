// Pi never writes notification bytes to TUI stdout: a detached dispatcher owns
// Kitty-tab mute state, focus suppression and notify-send.
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISPATCHER = path.join(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "notify.py");
const DEFAULT_BODY = "Ready for input";
const MAX_BODY_CHARS = 240;

/** Remove control bytes (C0/C1 + DEL) so nothing can break an OSC payload. */
function stripControl(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Build a compact, useful summary from the final assistant message. */
function notificationBody(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as {
			role?: unknown;
			content?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		if (message?.role !== "assistant") continue;

		const parts = Array.isArray(message.content)
			? message.content
					.filter(
						(part): part is { type: "text"; text: string } =>
							typeof part === "object" &&
							part !== null &&
							(part as { type?: unknown }).type === "text" &&
							typeof (part as { text?: unknown }).text === "string",
					)
					.map((part) => part.text)
			: [];
		let text = parts.join(" ").trim();
		if (!text && (message.stopReason === "error" || message.stopReason === "aborted")) {
			text = typeof message.errorMessage === "string"
				? message.errorMessage
				: `Agent ${message.stopReason}`;
		}
		if (!text) continue;

		text = stripControl(text.replace(/[\r\n\t]+/g, " "))
			.replace(/```(?:\w+)?/g, " ")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
			.replace(/^[#>*+\-\d.()\s]+/, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		const chars = Array.from(text);
		return chars.length > MAX_BODY_CHARS
			? `${chars.slice(0, MAX_BODY_CHARS - 1).join("")}…`
			: text;
	}
	return DEFAULT_BODY;
}

function notificationTitle(): string {
	const project = Array.from(stripControl(path.basename(process.cwd()) || process.cwd()));
	const label = project.length > 48
		? `${project.slice(0, 47).join("")}…`
		: project.join("");
	return `Pi · ${label}`;
}

function isHandoffTurn(messages: unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; customType?: unknown; details?: { kind?: unknown } };
		if (message?.role === "custom") {
			if (message.customType === "bus-handoff" || message.customType === "bus-autopilot" || message.customType === "bus")
				return message.customType === "bus-handoff" || message.customType === "bus-autopilot" || message.details?.kind === "handoff";
		}
		if (message?.role === "user") return false;
	}
	return false;
}

function notificationNeedsAttention(event: { aborted?: unknown; messages: unknown[] }): boolean {
	if (event.aborted === true) return true;
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const message = event.messages[i] as { role?: unknown; stopReason?: unknown };
		if (message?.role === "assistant") return message.stopReason === "error" || message.stopReason === "aborted";
	}
	return false;
}

function notify(title: string, body: string, needsAttention: boolean): void {
	try {
		const child = spawn(DISPATCHER, ["send", title, body, ...(needsAttention ? [] : ["--completion"])], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {}
}

function setKittyVar(isTui: boolean, ...args: string[]): Promise<void> {
	if (!isTui) return Promise.resolve();
	return new Promise((resolve) => {
		execFile(DISPATCHER, args, { timeout: 1500 }, () => resolve());
	});
}

const REGISTRY = process.env.PI_SESSION_REGISTRY ?? path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local/state"), "pi-terminal/sessions");

function processStart(pid: number): string {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function registerSession(cwd: string, session: string): void {
	const windowId = Number(process.env.KITTY_WINDOW_ID);
	const kittyPid = Number(process.env.KITTY_PID);
	if (!Number.isInteger(windowId) || !Number.isInteger(kittyPid)) return;
	try {
		fs.mkdirSync(REGISTRY, { recursive: true, mode: 0o700 });
		const file = path.join(REGISTRY, `${process.pid}.json`);
		const entry = { pid: process.pid, start: processStart(process.pid), cwd, session, windowId, kittyPid, kittyStart: processStart(kittyPid), updated: Date.now() };
		fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		fs.renameSync(`${file}.tmp`, file);
	} catch {}
}

export default function (pi: ExtensionAPI) {
	let kittyConfigReloadStarted = false;
	let activeSession: { cwd: string; session: string } | undefined;
	const stopAutopilotListener = pi.events.on("agent-bus:autopilot:v1", (payload: unknown) => {
		const event = payload as { pid?: unknown; cwd?: unknown; session?: unknown; state?: unknown; reason?: unknown };
		if (!activeSession || event?.pid !== process.pid || event.cwd !== activeSession.cwd || event.session !== activeSession.session ||
			(event.state !== "off" && event.state !== "waiting") || typeof event.reason !== "string") return;
		const reason = stripControl(event.reason.replace(/[\r\n\t]+/g, " ")).replace(/\s+/g, " ").trim();
		const label = event.state === "off" ? "stopped" : "waiting";
		const body = Array.from(`Autopilot ${label}${reason ? `: ${reason}` : ""}`).slice(0, MAX_BODY_CHARS).join("");
		notify(notificationTitle(), body, true);
	});
	pi.on("session_start", async (_event, ctx) => {
		activeSession = ctx.mode === "tui" && ctx.sessionManager.getSessionFile()
			? { cwd: fs.realpathSync(ctx.cwd), session: ctx.sessionManager.getSessionFile()! }
			: undefined;
		if (activeSession) registerSession(activeSession.cwd, activeSession.session);
		await setKittyVar(ctx.mode === "tui", "agent-status", "clear");
		await setKittyVar(ctx.mode === "tui", "session-file", ctx.sessionManager.getSessionFile() ?? "");
	});
	pi.on("before_agent_start", async (_event, ctx) => setKittyVar(ctx.mode === "tui", "agent-status", "busy"));
	pi.on("agent_start", async (_event, ctx) => setKittyVar(ctx.mode === "tui", "agent-status", "busy"));
	pi.on("tool_execution_start", async (_event, ctx) => setKittyVar(ctx.mode === "tui", "agent-status", "busy"));
	pi.on("agent_settled", async (_event, ctx) => setKittyVar(ctx.mode === "tui", "agent-status", "done"));
	pi.on("session_shutdown", async (event, ctx) => {
		activeSession = undefined;
		stopAutopilotListener();
		await setKittyVar(ctx.mode === "tui", "agent-status", "clear");
		await setKittyVar(ctx.mode === "tui", "session-file", "");
		const socket = process.env.KITTY_LISTEN_ON;
		if (ctx.mode === "tui" && (event.reason as string) === "restart" && socket && !kittyConfigReloadStarted) {
			kittyConfigReloadStarted = true;
			try {
				await new Promise<void>((resolve, reject) => {
					execFile("kitten", ["@", "--to", socket, "load-config"], { timeout: 1500 }, (error) => {
						if (error) reject(error);
						else resolve();
					});
				});
			} catch (error) {
				ctx.ui.notify(`Kitty config reload failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
	});
	pi.on("agent_end", async (event, ctx) => {
		if (ctx.mode === "tui" && !isHandoffTurn(event.messages)) notify(notificationTitle(), notificationBody(event.messages), notificationNeedsAttention(event));
	});
}
