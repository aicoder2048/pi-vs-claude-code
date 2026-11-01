/**
 * TillDone L4: rendering only. Every function takes an immutable ListState
 * (or a Details snapshot) and returns lines or installs components. Nothing
 * here writes state or holds a reference to the L2 cell.
 *
 * The footer and widget close over the value passed to paint() instead of
 * reading live state. That is equivalent because L2 repaints on every commit
 * and ListState values are frozen.
 */

import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Details, ListState, Params, Status, Task } from "./state.ts";
import { countByStatus, current, STATUS_ICON } from "./state.ts";

const STATUS_KEY = "tilldone";
const WIDGET_KEY = "tilldone-current";

/** Order matches the original refreshUI: status, widget, footer. */
export function paint(ui: ExtensionUIContext, list: ListState): void {
	ui.setStatus(STATUS_KEY, statusText(list));

	const cur = current(list);
	if (cur) ui.setWidget(WIDGET_KEY, (_tui, theme) => widget(cur, theme), { placement: "belowEditor" });
	else ui.setWidget(WIDGET_KEY, undefined);

	ui.setFooter((tui, theme, footerData) => ({
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render: (width: number) => footerLines(list, theme, width),
	}));
}

export function statusText(list: ListState): string {
	const total = list.tasks.length;
	if (total === 0) return "📋 TillDone: no tasks";
	const remaining = total - countByStatus(list).done;
	return `${list.title ? `📋 ${list.title}` : "📋 TillDone"}: ${total} tasks (${remaining} remaining)`;
}

function widget(task: Task, theme: Theme) {
	const container = new Container();
	const borderFn = (s: string) => theme.fg("dim", s);
	container.addChild(new Text("", 0, 0));
	container.addChild(new DynamicBorder(borderFn));
	const content = new Text("", 1, 0);
	container.addChild(content);
	container.addChild(new DynamicBorder(borderFn));

	return {
		render(width: number): string[] {
			const line =
				theme.fg("accent", "● ") +
				theme.fg("dim", "WORKING ON  ") +
				theme.fg("accent", `#${task.id}`) +
				theme.fg("dim", "  ") +
				theme.fg("success", task.text);
			content.setText(truncateToWidth(line, width - 4));
			return container.render(width);
		},
		invalidate() {
			container.invalidate();
		},
	};
}

export function footerLines(list: ListState, theme: Theme, width: number): string[] {
	const { tasks, title } = list;
	const { done, inprogress: active, idle } = countByStatus(list);
	const total = tasks.length;

	const titleDisplay = title ? theme.fg("accent", ` ${title} `) : theme.fg("dim", " TillDone ");
	const l1Left =
		total === 0
			? titleDisplay + theme.fg("muted", "no tasks")
			: titleDisplay +
				theme.fg("warning", "[") +
				theme.fg("success", `${done}`) +
				theme.fg("dim", "/") +
				theme.fg("success", `${total}`) +
				theme.fg("warning", "]");
	const l1Right =
		total === 0
			? ""
			: theme.fg("dim", STATUS_ICON.idle + " ") +
				theme.fg("muted", `${idle}`) +
				theme.fg("dim", "  ") +
				theme.fg("accent", STATUS_ICON.inprogress + " ") +
				theme.fg("accent", `${active}`) +
				theme.fg("dim", "  ") +
				theme.fg("success", STATUS_ICON.done + " ") +
				theme.fg("success", `${done}`) +
				theme.fg("dim", " ");
	const pad1 = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
	const line1 = truncateToWidth(l1Left + pad1 + l1Right, width, "");
	if (total === 0) return [line1];

	const activeTasks = tasks.filter((t) => t.status === "inprogress");
	const doneTasks = tasks.filter((t) => t.status === "done").reverse();
	const visible = [...activeTasks, ...doneTasks].slice(0, 5);
	const remaining = total - visible.length;

	const rows = visible.map((t) => {
		const icon = t.status === "done" ? theme.fg("success", STATUS_ICON.done) : theme.fg("accent", STATUS_ICON.inprogress);
		const text = t.status === "done" ? theme.fg("dim", t.text) : theme.fg("success", t.text);
		return truncateToWidth(` ${icon} ${text}`, width, "");
	});
	if (remaining > 0) rows.push(truncateToWidth(` ${theme.fg("dim", `  +${remaining} more`)}`, width, ""));
	return [line1, ...rows];
}

/** Icon and text colors shared by the tool result list and the overlay. */
const ICON_COLOR = { done: "success", inprogress: "accent", idle: "dim" } as const satisfies Record<Status, string>;
const TEXT_COLOR = { done: "dim", inprogress: "success", idle: "muted" } as const satisfies Record<Status, string>;

const icon = (t: Task, theme: Theme) => theme.fg(ICON_COLOR[t.status], STATUS_ICON[t.status]);
const itemText = (t: Task, theme: Theme) => theme.fg(TEXT_COLOR[t.status], t.text);
const idLabel = (t: Task, theme: Theme) => theme.fg("accent", `#${t.id}`) + (t.from === undefined ? "" : theme.fg("dim", ` ← #${t.from}`));

// Tool renderers

export function renderCall(args: Params, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold("tilldone ")) + theme.fg("muted", args.action);
	if (args.texts?.length) text += ` ${theme.fg("dim", `${args.texts.length} tasks`)}`;
	else if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
	if (args.description) text += ` ${theme.fg("dim", `— ${args.description}`)}`;
	if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
	return new Text(text, 0, 0);
}

/** The prefix each action puts before the L3 result text. */
const RESULT_PREFIX = {
	add: ["success", "✓ "],
	update: ["success", "✓ "],
	start: ["accent", "▶ "],
	done: ["success", "✓ "],
	remove: ["warning", "✕ "],
	split: ["accent", "✂ "],
} as const;

export function renderResult(
	result: { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Text {
	const first = result.content[0];
	const resultText = first?.type === "text" ? (first.text ?? "") : "";
	const details = result.details as Details | undefined;
	if (!details) return new Text(resultText, 0, 0);
	if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

	switch (details.action) {
		case "new-list": {
			let msg = theme.fg("success", "✓ New list ") + theme.fg("accent", `"${details.listTitle}"`);
			if (details.listDescription) msg += theme.fg("dim", ` — ${details.listDescription}`);
			return new Text(msg, 0, 0);
		}
		case "list": {
			const tasks = details.tasks;
			if (tasks.length === 0) return new Text(theme.fg("dim", "No tasks"), 0, 0);
			let text = details.listTitle ? theme.fg("accent", details.listTitle) + theme.fg("dim", "  ") : "";
			text += theme.fg("muted", `${tasks.length} task(s):`);
			for (const t of expanded ? tasks : tasks.slice(0, 5)) {
				text += `\n${icon(t, theme)} ${idLabel(t, theme)} ${itemText(t, theme)}`;
			}
			if (!expanded && tasks.length > 5) text += `\n${theme.fg("dim", `... ${tasks.length - 5} more`)}`;
			return new Text(text, 0, 0);
		}
		case "add":
		case "update":
		case "start":
		case "done":
		case "remove":
		case "split": {
			const [color, prefix] = RESULT_PREFIX[details.action];
			return new Text(theme.fg(color, prefix) + theme.fg("muted", resultText), 0, 0);
		}
		case "clear":
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all tasks"), 0, 0);
		default:
			return new Text(theme.fg("dim", "done"), 0, 0);
	}
}

// /tilldone overlay

class TillDoneListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly list: ListState,
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const { tasks, title, description } = this.list;
		const lines: string[] = [""];

		const heading = th.fg("accent", title ? ` ${title} ` : " TillDone ");
		// Width uses title.length, not visible width, to match the original.
		const headingLen = title ? title.length + 2 : 10;
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + heading + th.fg("borderMuted", "─".repeat(Math.max(0, width - 3 - headingLen))), width));
		if (description) lines.push(truncateToWidth(`  ${th.fg("muted", description)}`, width));
		lines.push("");

		if (tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`, width));
		} else {
			const { done, inprogress, idle } = countByStatus(this.list);
			lines.push(
				truncateToWidth(
					"  " +
						th.fg("success", `${done} done`) +
						th.fg("dim", "  ") +
						th.fg("accent", `${inprogress} active`) +
						th.fg("dim", "  ") +
						th.fg("muted", `${idle} idle`),
					width,
				),
			);
			lines.push("");
			for (const t of tasks) lines.push(truncateToWidth(`  ${icon(t, th)} ${idLabel(t, th)} ${itemText(t, th)}`, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Shows the overlay for a fixed snapshot; resolves when closed. */
export function showList(ui: ExtensionUIContext, list: ListState): Promise<void> {
	return ui.custom<void>((_tui, theme, _kb, done) => new TillDoneListComponent(list, theme, () => done()));
}
