/* Based on examples/extensions/border-status-editor.ts */

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import * as piSdk from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type BusState = {
	pid: number;
	cwd: string;
	session: string;
	awaitingReplies: number;
	awaitingPeers: string[];
};

type StatusSegment = { text: string; drop: number };
type CachePrediction = { probability: number | null; samples: number; account: string; lastRequestAt: number | null; reason: string };

function fitBorderSegmented(
	left: (width: number) => string,
	minLeftWidth: number,
	rightSegs: StatusSegment[],
	width: number,
	border: (text: string) => string,
	activity: string[] = [],
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const minGap = Math.min(3, Math.max(0, width - minLeftWidth));
	const right = rightSegs.filter((s) => s.text.length > 0);
	const rightText = () => right.map((s) => s.text).join(" ");
	let status = activity.filter(Boolean).join(border("─────"));
	const statusWidth = () => status ? visibleWidth(status) + 1 : 0;
	const fits = () => minLeftWidth + statusWidth() + visibleWidth(rightText()) + minGap <= width;
	const dropNext = () => {
		const priority = Math.min(...right.map((s) => s.drop));
		right.splice(right.findIndex((s) => s.drop === priority), 1);
	};

	if (!fits()) status = activity[0] ?? "";
	// Thinking and token count yield before the folder or stopped time.
	while (!fits() && right.some((s) => s.drop <= 1)) dropNext();
	if (!fits()) status = "";
	while (!fits() && right.length > 0) dropNext();

	const rightStr = rightText();
	const pathWidth = Math.max(0, width - visibleWidth(rightStr) - statusWidth() - minGap);
	const leftStr = left(pathWidth) + (status ? ` ${status}` : "");
	const gap = Math.max(0, width - visibleWidth(leftStr) - visibleWidth(rightStr));
	return `${leftStr}${border("─".repeat(gap))}${rightStr}`;
}

function formatCwd(cwd: string, width: number): string {
	if (width <= 0) return "";
	const home = process.env.HOME;
	let display = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
	if (visibleWidth(display) > width) {
		const parts = display.replace(/\/+$/, "").split("/");
		let tail = parts.pop() || "/";
		while (parts.length > 0 && visibleWidth(`…/${parts.at(-1)}/${tail}`) <= width) {
			tail = `${parts.pop()}/${tail}`;
		}
		display = visibleWidth(`…/${tail}`) <= width ? `…/${tail}` : stripTerminalSequences(truncateToWidth(tail, width, "…"));
	}
	return `\x1b]8;;pi-slim-copy:${encodeURIComponent(cwd)}\x1b\\${display}\x1b]8;;\x1b\\`;
}

function contextSegments(ctx: ExtensionContext): string[] {
	const usage = ctx.getContextUsage();
	if (!usage) return [];
	const segs: string[] = [];
	if (usage.percent !== null) segs.push(`ctx ${Math.round(usage.percent)}%`);
	if (usage.tokens !== null) {
		segs.push(usage.tokens < 5000 ? `${usage.tokens}` : `${Math.round(usage.tokens / 1000)}k`);
	}
	return segs;
}

function formatStopped(at: number): string {
	const date = new Date(at);
	return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let activeContext: ExtensionContext | undefined;
	let lastStopped: number | undefined;
	let waitingReason = "";
	let cacheStatus = "";
	let cacheTimer: ReturnType<typeof setInterval> | undefined;
	let cacheGeneration = 0;
	let cacheResetAt: number | undefined;
	let branchCache: string | undefined;
	// Captured from inside the setFooter factory; lets the editor read extension statuses.
	let footerDataRef:
		| {
				getGitBranch(): string | null;
				getExtensionStatuses(): ReadonlyMap<string, string>;
		  }
		| undefined;

	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	function stopCacheStatus() {
		cacheGeneration++;
		if (cacheTimer) clearInterval(cacheTimer);
		cacheTimer = undefined;
		cacheStatus = "";
		cacheResetAt = undefined;
	}

	async function refreshCacheStatus(ctx: ExtensionContext) {
		const generation = ++cacheGeneration;
		cacheStatus = ctx.mode === "tui" && ctx.model?.provider === "openai-codex" ? "c?" : "";
		activeTui?.requestRender();
		if (ctx.mode !== "tui" || !cacheStatus) return;
		const model = ctx.model!.id;
		try {
			const getAccountId = (ctx.modelRegistry as typeof ctx.modelRegistry & {
				getCodexAccountId?: () => Promise<string | undefined>;
			}).getCodexAccountId;
			if (!getAccountId) return;
			const accountId = await getAccountId.call(ctx.modelRegistry);
			if (generation !== cacheGeneration || !accountId) return;
			const getCachePrediction = (piSdk as typeof piSdk & {
				getCachePrediction?: (options: { sessionId: string; model: string; accountId: string }) => CachePrediction;
			}).getCachePrediction;
			if (!getCachePrediction) return;
			const prediction = getCachePrediction({ sessionId: ctx.sessionManager.getSessionId(), model, accountId });
			if (generation !== cacheGeneration) return;
			if (cacheResetAt !== undefined) {
				if (prediction.lastRequestAt === null || prediction.lastRequestAt <= cacheResetAt) return;
				cacheResetAt = undefined;
			}
			if (prediction.probability !== null && Number.isFinite(prediction.probability) &&
				prediction.probability >= 0 && prediction.probability <= 1) {
				cacheStatus = `c${Math.round(prediction.probability * 100)}%`;
				activeTui?.requestRender();
			}
		} catch {
			// An older SDK or unsupported credentials have no prediction.
		}
	}

	pi.events.on("agent-bus:state:v1", (event: unknown) => {
		const ctx = activeContext;
		if (!ctx || ctx.mode !== "tui") return;
		const state = event as Partial<BusState> | undefined;
		const session = ctx.sessionManager.getSessionFile();
		if (!state || state.pid !== process.pid || state.cwd !== realpathSync(ctx.cwd) || !session || state.session !== session ||
			!Number.isSafeInteger(state.awaitingReplies) || state.awaitingReplies! < 0 || !Array.isArray(state.awaitingPeers)) return;
		const peers = state.awaitingPeers.filter((path): path is string => typeof path === "string" && path.length > 0);
		const names = [...new Set(peers.map(path => basename(path)))];
		const reason = !state.awaitingReplies ? "" : names.length ? `parley with ${names.join(" ")}` : "waiting for reply";
		if (reason !== waitingReason) {
			waitingReason = reason;
			activeTui?.requestRender();
		}
	});

	pi.on("agent_start", () => {
		isWorking = true;
		if (!enabled) return;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 80);
		activeTui?.requestRender();
	});

	pi.on("agent_settled", (event, ctx) => {
		if (isWorking) {
			const entry = event.executionReceipt ? ctx.sessionManager.getEntry(event.executionReceipt.entryId) : undefined;
			const at = entry ? Date.parse(entry.timestamp) : NaN;
			lastStopped = Number.isFinite(at) ? at : Date.now();
			pi.appendEntry("pi-slim.stopped", { at: lastStopped });
		}
		isWorking = !ctx.isIdle();
		if (!isWorking) stopSpinner();
		void refreshCacheStatus(ctx);
		activeTui?.requestRender();
	});

	pi.on("model_select", (_event, ctx) => { void refreshCacheStatus(ctx); });
	const invalidateCacheSeed = (_event: unknown, ctx: ExtensionContext) => {
		cacheResetAt = Date.now();
		void refreshCacheStatus(ctx);
	};
	pi.on("session_tree", invalidateCacheSeed);
	pi.on("session_compact", invalidateCacheSeed);

	pi.on("session_shutdown", () => {
		stopCacheStatus();
		stopSpinner();
		activeTui = undefined;
		footerDataRef = undefined;
		activeContext = undefined;
		lastStopped = undefined;
		waitingReason = "";
		isWorking = false;
	});

	pi.on("session_start", (_event, ctx) => {
		stopCacheStatus();
		activeContext = ctx;
		void refreshCacheStatus(ctx);
		if (ctx.mode === "tui") {
			cacheTimer = setInterval(() => { void refreshCacheStatus(ctx); }, 300_000);
			cacheTimer.unref();
		}
		lastStopped = undefined;
		waitingReason = "";
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			const data = entry.data as { at?: number; kind?: string; status?: string } | undefined;
			const at = entry.customType === "pi-slim.stopped" ? data?.at
				: entry.customType === "pi.execution.v1" && data?.kind === "execution" &&
					["completed", "failed", "aborted", "suspended"].includes(data.status ?? "") ? Date.parse(entry.timestamp) : undefined;
			if (typeof at === "number" && Number.isFinite(at) && (lastStopped === undefined || at > lastStopped)) lastStopped = at;
		}
		isWorking = !ctx.isIdle();
		spinnerIndex = 0;
		branchCache = undefined;
		if (enabled) applySlim(ctx);
	});

	function applySlim(ctx: ExtensionContext) {
		ctx.ui.setWorkingVisible(false);

		// Sink footer: renders nothing, but subscribes to live git branch updates and exposes
		// FooterDataProvider so the editor can read extension statuses from setStatus().
		ctx.ui.setFooter((tui, _theme, footerData) => {
			footerDataRef = footerData;
			branchCache = footerData.getGitBranch() ?? undefined;
			const unsub = footerData.onBranchChange(() => {
				branchCache = footerData.getGitBranch() ?? undefined;
				tui.requestRender();
			});
			return {
				render: () => [],
				invalidate: () => {},
				dispose: () => {
					unsub();
					if (footerDataRef === footerData) footerDataRef = undefined;
				},
			};
		});

		class SlimEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 1 });
				activeTui = tui;
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length < 2) return lines;

				const thm = ctx.ui.theme;
				const muted = (s: string) => thm.fg("muted", s);
				const accent = (s: string) => thm.fg("accent", s);

				const spinner = isWorking ? accent(spinnerFrames[spinnerIndex]) : "";
				const left = (budget: number) => spinner + muted(formatCwd(ctx.cwd, budget - visibleWidth(spinner)));
				const minLeftWidth = visibleWidth(spinner) + visibleWidth(basename(ctx.cwd) || "/");

				const right: StatusSegment[] = [];
				const statuses = footerDataRef?.getExtensionStatuses();
				if (statuses && statuses.size > 0) {
					right.push({ text: muted([...statuses.values()].join(" ")), drop: 2 });
				}
				for (const seg of contextSegments(ctx)) right.push({ text: muted(seg), drop: seg.includes("%") ? 3 : 1 });
				if (cacheStatus) right.push({ text: muted(cacheStatus), drop: 2 });
				right.push({ text: muted(ctx.model?.id.replaceAll("-", "") ?? "no model"), drop: 4 });
				const thinking = pi.getThinkingLevel();
				if (thinking !== "off") right.push({ text: muted(thinking), drop: 0 });

				lines[0] = fitBorderSegmented(left, minLeftWidth, right, width, muted, [
					lastStopped === undefined ? "" : formatStopped(lastStopped),
					isWorking ? "" : waitingReason,
				]);
				// Drop the bottom border row — all status info lives on top now.
				if (this.isShowingAutocomplete()) return lines;
				return lines.slice(0, -1);
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SlimEditor(tui, theme, keybindings));
	}

	function clearSlim(ctx: ExtensionContext) {
		stopSpinner();
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
		footerDataRef = undefined;
	}

	pi.registerCommand("slim", {
		description: "Toggle pi-slim chrome (slim status row vs default footer)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				applySlim(ctx);
				ctx.ui.notify("pi-slim: on", "info");
			} else {
				clearSlim(ctx);
				ctx.ui.notify("pi-slim: off (default footer restored)", "info");
			}
		},
	});
}
