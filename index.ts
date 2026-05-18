/* Based on examples/extensions/border-status-editor.ts */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SEP = " · ";

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
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const corners = 2;
	const minGap = 3;

	const joinSegs = (segs: string[]): string => {
		const present = segs.filter((s) => s.length > 0);
		return present.length === 0 ? "" : ` ${present.join(SEP)} `;
	};

	const left = leftSegs.filter((s) => s.length > 0);
	const right = rightSegs.filter((s) => s.length > 0);

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
	return `${border("─")}${leftStr}${border("─".repeat(gap))}${rightStr}${border("─")}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
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

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
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

	pi.on("agent_start", () => {
		if (!enabled) return;
		isWorking = true;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 80);
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
		footerDataRef = undefined;
		isWorking = false;
	});

	pi.on("session_start", (_event, ctx) => {
		isWorking = false;
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

				const borderColor = (text: string) => this.borderColor(text);
				lines[0] = fitBorderSegmented(left, right, width, borderColor);
				// Drop the bottom border row — all status info lives on top now.
				return lines.slice(0, -1);
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SlimEditor(tui, theme, keybindings));
	}

	function clearSlim(ctx: ExtensionContext) {
		stopSpinner();
		isWorking = false;
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
