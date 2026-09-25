/**
 * pi-notify-local
 *
 * Fires a desktop notification when the Pi agent finishes a turn and is ready
 * for input again ("Ready for input").
 *
 * Why this exists: the previous notifier wrote raw OSC notification escape
 * sequences straight into the shared TUI stdout. On kitty those bytes race
 * with Pi's own renderer (SGR resets, OSC-8 hyperlinks) and corrupt the
 * notification body, e.g. "Ready \e[49m\e[0m8;;" instead of "Ready for input".
 *
 * The fix: emit every completion event to a detached local dispatcher. The
 * dispatcher owns Kitty-tab mute state and calls `notify-send` only when the
 * source tab is enabled. Pi never writes notification bytes into TUI stdout.
 * Terminal OSC remains only as a fallback without a desktop notification path.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISPATCHER = "/home/sr/dev/pi/pi-notify/notify.py";
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

/** Resolve an executable on PATH synchronously; null if not found. */
function resolveOnPath(bin: string): string | null {
	if (process.platform === "win32") return null;
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		const full = path.join(dir, bin);
		try {
			fs.accessSync(full, fs.constants.X_OK);
			return full;
		} catch {
			/* not here, keep looking */
		}
	}
	return null;
}

/**
 * Path to `notify-send` when a desktop session is present, else null. This is
 * checked before we commit to the desktop path so a missing binary falls back
 * to OSC instead of silently dropping the notification.
 */
function notifySendPath(): string | null {
	if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
	return resolveOnPath("notify-send");
}

/**
 * Primary path: every event reaches the notification-side dispatcher. It maps
 * KITTY_WINDOW_ID to a Kitty tab, checks the shared tab mute marker, then sends
 * through libnotify and runs the optional sound only when not muted.
 */
function notifyViaDispatcher(title: string, body: string, needsAttention: boolean): boolean {
	if (!notifySendPath()) return false;
	try {
		fs.accessSync(DISPATCHER, fs.constants.X_OK);
		const child = spawn(DISPATCHER, ["send", title, body, ...(needsAttention ? [] : ["--completion"])], {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			/* helper disappeared after the access check; best-effort */
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** tmux passthrough: only wrap when inside tmux, and only for OSC output. */
function wrapForTmux(sequence: string): string {
	if (!process.env.TMUX) return sequence;
	const escaped = sequence.split("\x1b").join("\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

/** Last fallback when no desktop notification path is available. */
function notifyOSC(title: string, body: string): void {
	const t = stripControl(title);
	const b = stripControl(body);
	const isIterm2 =
		process.env.TERM_PROGRAM === "iTerm.app" ||
		Boolean(process.env.ITERM_SESSION_ID);
	const inner = isIterm2
		? `\x1b]9;${t}: ${b}\x07`
		: `\x1b]777;notify;${t};${b}\x07`;
	try {
		fs.writeFileSync(process.stdout.fd, wrapForTmux(inner));
	} catch {
		/* notification is best-effort */
	}
}

/** Optional cross-platform sound hook via PI_NOTIFY_SOUND_CMD. */
function runSoundHook(): void {
	const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
	if (!command) return;
	try {
		const child = spawn(command, {
			shell: true,
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			/* swallow: sound is best-effort */
		});
		child.unref();
	} catch {
		/* swallow: never break notifications over a sound hook */
	}
}

function notify(title: string, body: string, needsAttention: boolean): void {
	if (notifyViaDispatcher(title, body, needsAttention)) return;
	notifyOSC(title, body);
	runSoundHook();
}

function setKittyAgentStatus(isTui: boolean, status: "busy" | "done" | "clear"): Promise<void> {
	if (!isTui) return Promise.resolve();
	return new Promise((resolve) => {
		execFile(DISPATCHER, ["agent-status", status], { timeout: 1500 }, () => resolve());
	});
}

function setKittySessionFile(isTui: boolean, file: string): Promise<void> {
	if (!isTui) return Promise.resolve();
	return new Promise((resolve) => {
		execFile(DISPATCHER, ["session-file", file], { timeout: 1500 }, () => resolve());
	});
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
		await setKittyAgentStatus(ctx.mode === "tui", "clear");
		await setKittySessionFile(ctx.mode === "tui", ctx.sessionManager.getSessionFile() ?? "");
	});
	pi.on("before_agent_start", async (_event, ctx) => setKittyAgentStatus(ctx.mode === "tui", "busy"));
	pi.on("agent_start", async (_event, ctx) => setKittyAgentStatus(ctx.mode === "tui", "busy"));
	pi.on("tool_execution_start", async (_event, ctx) => setKittyAgentStatus(ctx.mode === "tui", "busy"));
	pi.on("agent_settled", async (_event, ctx) => setKittyAgentStatus(ctx.mode === "tui", "done"));
	pi.on("session_shutdown", async (event, ctx) => {
		activeSession = undefined;
		stopAutopilotListener();
		await setKittyAgentStatus(ctx.mode === "tui", "clear");
		await setKittySessionFile(ctx.mode === "tui", "");
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
	pi.on("agent_end", async (event) => {
		if (!isHandoffTurn(event.messages)) notify(notificationTitle(), notificationBody(event.messages), notificationNeedsAttention(event));
	});
}
