/* Based on examples/extensions/border-status-editor.ts */

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Target = { pid: number; cwd: string; session: string };
type PendingRound = { origin: Target; taskId: string; executionId: string; roundId: string; aggregateId: string };
type WakeSnapshot = { owner: Target; known: boolean; pending: { run: string; mode: "observe" | "launch" }[] };
type WakeAdapter = {
	pendingWakes(owner: Target): Promise<WakeSnapshot>;
	watchPendingWakes(callback: () => void, owner: Target): () => void;
	hasLivePendingWake(snapshot: WakeSnapshot): boolean;
};
type WakeScope = { owner: Target; adapter?: WakeAdapter; snapshot?: WakeSnapshot; dispose?: () => void; refreshing: boolean; dirty: boolean };
type IntentEditor = CustomEditor & { submit?: (options?: { submitIntent: "submit" | "followUp"; submitContext?: unknown }) => void };
type DeliveryState = {
	version: 1;
	available: boolean;
	target?: Target;
	phase?: string;
	frozen?: boolean;
	pendingRound?: PendingRound | null;
	deferredCount?: number;
};

const SEP = " ";

/**
 * Render a horizontal rule with left/right segment lists inlaid into it.
 * Whole segments are dropped from the trailing edge before character-level truncation kicks in,
 * so narrow terminals lose `thinking` before `model` before `ctx %`, never mid-word.
 */
function fitBorderSegmented(
	leftSegs: string[],
	rightSegs: string[],
	width: number,
	border: (text: string) => string,
	activity: string[] = [],
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const corners = 0;
	const minGap = 3;

	const joinSegs = (segs: string[]): string => {
		const present = segs.filter((s) => s.length > 0);
		return present.join(SEP);
	};

	const left = leftSegs.filter((s) => s.length > 0);
	const right = rightSegs.filter((s) => s.length > 0);
	let status = activity.filter(Boolean).join(` ${border("─────")} `);
	const available = width - visibleWidth(joinSegs(right)) - minGap;
	if (visibleWidth(joinSegs(left)) + 1 + visibleWidth(status) > available) status = activity[0] ?? "";
	if (status && visibleWidth(joinSegs(left)) + 1 + visibleWidth(status) > available) {
		const pathWidth = available - visibleWidth(status) - 1;
		if (pathWidth >= 8) left.splice(0, left.length, truncateToWidth(joinSegs(left), pathWidth));
		else status = "";
	}
	if (status) left.push(status);
	if (available >= 8 && visibleWidth(joinSegs(left)) > available) {
		left.splice(0, left.length, truncateToWidth(joinSegs(left), available));
	}

	const fits = () =>
		corners + visibleWidth(joinSegs(left)) + visibleWidth(joinSegs(right)) + minGap <= width;

	while (!fits() && right.length > 0) right.pop();
	while (!fits() && left.length > 0) left.pop();

	let leftStr = joinSegs(left);
	let rightStr = joinSegs(right);

	// Character-level fallback if a single remaining segment is itself too wide.
	while (
		corners + visibleWidth(leftStr) + visibleWidth(rightStr) + minGap > width &&
		visibleWidth(rightStr) > 0
	) {
		rightStr = truncateToWidth(rightStr, Math.max(0, visibleWidth(rightStr) - 1), "");
	}
	while (
		corners + visibleWidth(leftStr) + visibleWidth(rightStr) + minGap > width &&
		visibleWidth(leftStr) > 0
	) {
		leftStr = truncateToWidth(leftStr, Math.max(0, visibleWidth(leftStr) - 1), "");
	}

	const gap = Math.max(0, width - corners - visibleWidth(leftStr) - visibleWidth(rightStr));
	return `${leftStr}${border("─".repeat(gap))}${rightStr}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
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
	const month = date.toLocaleString("en-US", { month: "short" });
	return `${String(date.getDate()).padStart(2, "0")} ${month} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let activeContext: ExtensionContext | undefined;
	let pendingRound: PendingRound | null = null;
	let lastStopped: number | undefined;
	let waitingReason = "";
	let wakeScope: WakeScope | undefined;
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

	function refreshPendingRound() {
		pendingRound = null;
		if (activeContext) {
			const state: DeliveryState = { version: 1, available: false };
			try {
				pi.events.emit("pi-handoff-queue:delivery-state:v1", state);
				const session = activeContext.sessionManager.getSessionFile();
				if (state.available && !state.frozen && state.phase === "ready" && session &&
					state.target?.pid === process.pid && state.target.cwd === realpathSync(activeContext.cwd) &&
					state.target.session === session && Number.isSafeInteger(state.deferredCount) && state.deferredCount! >= 0) {
					pendingRound = state.pendingRound ?? null;
				}
			} catch {
				pendingRound = null;
			}
		}
		activeTui?.requestRender();
	}

	function stopWakeStatus() {
		const previous = wakeScope;
		wakeScope = undefined;
		previous?.dispose?.();
	}

	function refreshWakes(scope: WakeScope) {
		if (wakeScope !== scope || !scope.adapter) return;
		scope.snapshot = undefined;
		scope.dirty = true;
		activeTui?.requestRender();
		if (scope.refreshing) return;
		scope.refreshing = true;
		void (async () => {
			for (let pass = 0; pass < 2 && wakeScope === scope && scope.dirty; pass++) {
				scope.dirty = false;
				let snapshot: WakeSnapshot | undefined;
				try { snapshot = await scope.adapter!.pendingWakes(scope.owner); } catch { snapshot = undefined; }
				if (wakeScope !== scope || scope.dirty) continue;
				if (snapshot?.owner.pid === scope.owner.pid && snapshot.owner.cwd === scope.owner.cwd && snapshot.owner.session === scope.owner.session) {
					scope.snapshot = snapshot;
				}
				activeTui?.requestRender();
			}
		})().finally(() => {
			scope.refreshing = false;
			// A dirty trailing result stays hidden until a new lifecycle event.
			scope.dirty = false;
		});
	}

	async function startWakeStatus(ctx: ExtensionContext) {
		stopWakeStatus();
		if (ctx.mode !== "tui") return;
		const session = ctx.sessionManager.getSessionFile();
		if (!session) return;
		let scope: WakeScope | undefined;
		try {
			scope = { owner: { pid: process.pid, cwd: realpathSync(ctx.cwd), session }, refreshing: false, dirty: false };
			wakeScope = scope;
			const source = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));
			const adapter: WakeAdapter = await import(new URL("../subagent/pending-wakes.ts", source).href);
			if (wakeScope !== scope) return;
			scope.adapter = adapter;
			const current = scope;
			scope.dispose = adapter.watchPendingWakes(() => refreshWakes(current), scope.owner);
			refreshWakes(scope);
		} catch {
			if (wakeScope === scope) stopWakeStatus();
		}
	}

	function helperIsWaiting(): boolean {
		const scope = wakeScope;
		if (!scope?.snapshot?.known || !scope.snapshot.pending.length || !scope.adapter) return false;
		try { return scope.adapter.hasLivePendingWake(scope.snapshot); } catch { return false; }
	}

	function refreshWaiting() {
		waitingReason = "";
		try {
			const session = activeContext?.sessionManager.getSessionFile();
			if (session && activeContext) {
				const request: { version: 1; handled: boolean; expected: Target; pendingRound?: PendingRound | null; peers?: { folder: string; host?: string }[] } = {
					version: 1, handled: false, expected: { pid: process.pid, cwd: realpathSync(activeContext.cwd), session },
				};
				pi.events.emit("parley:pending-round:v1", request);
				if (request.handled && request.pendingRound) {
					const names = request.peers?.map(peer => `${peer.host ? `${peer.host}:` : ""}${basename(peer.folder)}`);
					waitingReason = names?.length ? `parley with ${names.join(" ")}` : "waiting for wake";
				}
			}
		} catch {
			waitingReason = "";
		}
		activeTui?.requestRender();
	}

	pi.events.on("pi-handoff-queue:changed:v1", (event: unknown) => {
		if ((event as { version?: number })?.version !== 1) return;
		refreshPendingRound();
		if (wakeScope) refreshWakes(wakeScope);
	});
	pi.events.on("parley:pending-round-changed:v1", refreshWaiting);

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
		refreshWaiting();
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", () => {
		stopWakeStatus();
		stopSpinner();
		activeTui = undefined;
		footerDataRef = undefined;
		activeContext = undefined;
		pendingRound = null;
		lastStopped = undefined;
		waitingReason = "";
		isWorking = false;
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		void startWakeStatus(ctx);
		lastStopped = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			const data = entry.data as { at?: number; kind?: string; status?: string } | undefined;
			const at = entry.customType === "pi-slim.stopped" ? data?.at
				: entry.customType === "pi.execution.v1" && data?.kind === "execution" &&
					["completed", "failed", "aborted", "suspended"].includes(data.status ?? "") ? Date.parse(entry.timestamp) : undefined;
			if (typeof at === "number" && Number.isFinite(at) && (lastStopped === undefined || at > lastStopped)) lastStopped = at;
		}
		refreshPendingRound();
		refreshWaiting();
		isWorking = !ctx.isIdle();
		spinnerIndex = 0;
		branchCache = undefined;
		if (enabled) applySlim(ctx);
	});

	function applySlim(ctx: ExtensionContext) {
		refreshPendingRound();
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

			private pendingSubmit() {
				const submit = (this as IntentEditor).submit;
				return pendingRound && typeof submit === "function" ? submit : undefined;
			}

			handleInput(data: string) {
				if (matchesKey(data, "alt+enter")) {
					refreshPendingRound();
					const submit = this.pendingSubmit();
					if (submit) {
						if (!this.disableSubmit) {
							const submitContext = structuredClone({ afterResults: pendingRound });
							submit.call(this, { submitIntent: "followUp", submitContext });
						}
						return;
					}
				}
				super.handleInput(data);
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length < 2) return lines;

				const thm = ctx.ui.theme;
				const muted = (s: string) => thm.fg("muted", s);
				const accent = (s: string) => thm.fg("accent", s);

				const left: string[] = [];
				if (isWorking) left.push(accent(spinnerFrames[spinnerIndex]));
				left.push(muted(formatCwd(ctx.cwd)));
				if (branchCache) left.push(muted(`(${branchCache})`));

				const right: string[] = [];
				const statuses = footerDataRef?.getExtensionStatuses();
				if (statuses && statuses.size > 0) {
					right.push(muted([...statuses.values()].join(" ")));
				}
				for (const seg of contextSegments(ctx)) right.push(muted(seg));
				right.push(muted(ctx.model?.id ?? "no model"));
				const thinking = pi.getThinkingLevel();
				if (thinking !== "off") right.push(muted(thinking));

				lines[0] = fitBorderSegmented(left, right, width, muted, [
					lastStopped === undefined ? "" : formatStopped(lastStopped),
					isWorking ? "" : waitingReason || (helperIsWaiting() ? "waiting for wake" : ""),
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
