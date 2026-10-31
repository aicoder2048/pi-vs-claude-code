/**
 * TillDone L3: the domain. Pure transitions over one deep-frozen Model value.
 *
 * Zero imports by design: `bun test` loads this file without Pi installed in
 * the repo, and L3 cannot reach Pi, the TUI, or L4. state.test.ts enforces it.
 *
 * Every string the model reads is defined here: tool description, parameter
 * descriptions, result texts, error codes, gate reasons, nudge content. The
 * confirm dialog text lives here too, because the decision to ask is a rule.
 */

// Data shape

export const STATUSES = ["idle", "inprogress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
	readonly id: number;
	readonly text: string;
	readonly status: Status;
}

/** The persisted part of the domain. */
export interface ListState {
	readonly tasks: readonly Task[];
	readonly nextId: number;
	readonly title: string | undefined;
	readonly description: string | undefined;
}

/**
 * The whole extension state. `nudged` is per user input and never persisted,
 * so restore() replaces `list` and keeps `nudged`, like the original.
 */
export interface Model {
	readonly list: ListState;
	readonly nudged: boolean;
}

/** Order is load-bearing: index.ts builds the StringEnum from it and the schema must match the original byte for byte. */
export const ACTIONS = ["new-list", "add", "toggle", "remove", "update", "list", "clear"] as const;
export type Action = (typeof ACTIONS)[number];

/** Tool params as Pi hands them over after schema validation. */
export interface Params {
	readonly action: Action;
	readonly text?: string;
	readonly texts?: readonly string[];
	readonly description?: string;
	readonly id?: number;
}

/**
 * Wire format stored as toolResult.details. Key order and the always-present
 * listTitle/listDescription keys match the original makeDetails, so sessions
 * written by either version restore in the other. `action` is a string because
 * the unknown-action branch writes "list".
 */
export interface Details {
	action: string;
	tasks: Task[];
	nextId: number;
	listTitle: string | undefined;
	listDescription: string | undefined;
	error?: string;
}

// Tables

export const STATUS_ICON: Readonly<Record<Status, string>> = { idle: "○", inprogress: "●", done: "✓" };
export const NEXT_STATUS: Readonly<Record<Status, Status>> = { idle: "inprogress", inprogress: "done", done: "idle" };
export const STATUS_LABEL: Readonly<Record<Status, string>> = { idle: "idle", inprogress: "in progress", done: "done" };

// Model-facing tool contract. index.ts turns this into the TypeBox schema.

export const TOOL = {
	name: "tilldone",
	label: "TillDone",
	description:
		"Manage your task list. You MUST add tasks before using any other tools; read-only tools (read, grep, find, ls) stay available for planning. " +
		"Actions: new-list (text=title, description), add (text or texts[] for batch), toggle (id) — cycles idle→inprogress→done, remove (id), update (id + text), list, clear. " +
		"Always toggle a task to inprogress before starting work on it, and to done when finished. " +
		"Use new-list to start a themed list with a title and description. " +
		"IMPORTANT: If the user's new request does not fit the current list's theme, use clear to wipe the slate and new-list to start fresh.",
	actions: ACTIONS,
	params: {
		text: "Task text (for add/update), or list title (for new-list)",
		texts: "Multiple task texts (for add). Use this to batch-add several tasks at once.",
		description: "List description (for new-list)",
		id: "Task ID (for toggle/remove/update)",
	},
	commandDescription: "Show all TillDone tasks on the current branch",
} as const;

export const GATE_REASON = {
	noTasks:
		"🚫 No TillDone tasks defined. You MUST use `tilldone new-list` or `tilldone add` to define your tasks before using any other tools (read-only tools — read, grep, find, ls — stay available for planning). Plan your work first!",
	allDone:
		"🚫 All TillDone tasks are done. You MUST use `tilldone add` for new tasks or `tilldone new-list` to start a fresh list before using any other tools (read-only tools — read, grep, find, ls — stay available for planning).",
	noneActive:
		"🚫 No task is in progress. You MUST use `tilldone toggle` to mark a task as inprogress before doing any work.",
} as const;

export const CONFIRM_TIMEOUT_MS = 30000;

// Construction. Every ListState is born here, frozen with fresh Task objects,
// so an in-place edit anywhere throws instead of rewriting history (the B1 class).

function makeList(tasks: readonly Task[], nextId: number, title: string | undefined, description: string | undefined): ListState {
	const frozen = Object.freeze(tasks.map((t) => Object.freeze({ id: t.id, text: t.text, status: t.status })));
	return Object.freeze({ tasks: frozen, nextId, title, description });
}

function makeModel(list: ListState, nudged: boolean): Model {
	return Object.freeze({ list, nudged });
}

export const EMPTY_LIST: ListState = makeList([], 1, undefined, undefined);
export const INITIAL_MODEL: Model = makeModel(EMPTY_LIST, false);

// Snapshot and restore boundary (copy in both directions)

/** Outbound copy: plain, unfrozen objects the session owns from now on. */
export function toDetails(list: ListState, action: string, error?: string): Details {
	return {
		action,
		tasks: list.tasks.map((t) => ({ id: t.id, text: t.text, status: t.status })),
		nextId: list.nextId,
		listTitle: list.title,
		listDescription: list.description,
		...(error ? { error } : {}),
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isOptString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

function parseTask(raw: unknown): Task | undefined {
	if (!isRecord(raw)) return undefined;
	const { id, text, status } = raw;
	if (typeof id !== "number" || typeof text !== "string" || !STATUSES.includes(status as Status)) return undefined;
	return { id, text, status: status as Status };
}

/**
 * Inbound parse of one untrusted details value (from disk or another version).
 * Returns undefined for anything malformed, which restore() skips.
 */
export function parseDetails(raw: unknown): ListState | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.tasks) || typeof raw.nextId !== "number") return undefined;
	if (!isOptString(raw.listTitle) || !isOptString(raw.listDescription)) return undefined;
	const tasks: Task[] = [];
	for (const t of raw.tasks) {
		const task = parseTask(t);
		if (!task) return undefined;
		tasks.push(task);
	}
	return makeList(tasks, raw.nextId, raw.listTitle, raw.listDescription);
}

/** Rebuilds the list from the branch's tilldone details in branch order; the last valid one wins. */
export function restore(model: Model, detailsInBranchOrder: readonly unknown[]): Model {
	let list = EMPTY_LIST;
	for (const raw of detailsInBranchOrder) list = parseDetails(raw) ?? list;
	return makeModel(list, model.nudged);
}

// Tool transition

export interface Ask {
	readonly kind: "ask";
	readonly title: string;
	readonly message: string;
	readonly timeoutMs: number;
}

/**
 * `next` is present exactly when the action succeeded: L2 commits it and
 * repaints. Errors and cancellations leave state and UI alone.
 */
export interface Reply {
	readonly kind: "reply";
	readonly text: string;
	readonly details: Details;
	readonly next?: Model;
}

/** A command that passed param-only validation. Illegal combinations are unrepresentable past validate(). */
type Valid =
	| { readonly kind: "new-list"; readonly title: string; readonly description: string | undefined }
	| { readonly kind: "list" }
	| { readonly kind: "add"; readonly items: readonly [string, ...string[]] }
	| { readonly kind: "toggle"; readonly id: number }
	| { readonly kind: "remove"; readonly id: number }
	| { readonly kind: "update"; readonly id: number; readonly text: string }
	| { readonly kind: "clear" };

type Validation =
	| { readonly ok: true; readonly cmd: Valid }
	| { readonly ok: false; readonly action: string; readonly text: string; readonly error: string };

const invalid = (action: string, text: string, error: string): Validation => ({ ok: false, action, text, error });
const valid = (cmd: Valid): Validation => ({ ok: true, cmd });

/** Param-only checks, in the original's order, with its exact strings. */
function validate(params: Params): Validation {
	const { action, text, texts, description, id } = params;
	switch (action) {
		case "new-list":
			return text ? valid({ kind: "new-list", title: text, description: description || undefined }) : invalid(action, "Error: text (title) required for new-list", "text required");
		case "list":
		case "clear":
			return valid({ kind: action });
		case "add": {
			const items = texts?.length ? texts : text ? [text] : [];
			return items.length > 0 ? valid({ kind: "add", items: items as readonly [string, ...string[]] }) : invalid(action, "Error: text or texts required for add", "text required");
		}
		case "toggle":
		case "remove":
			return id === undefined ? invalid(action, `Error: id required for ${action}`, "id required") : valid({ kind: action, id });
		case "update":
			if (id === undefined) return invalid(action, "Error: id required for update", "id required");
			if (!text) return invalid(action, "Error: text required for update", "text required");
			return valid({ kind: "update", id, text });
		default:
			return invalid("list", `Unknown action: ${action}`, `unknown action: ${action}`);
	}
}

const fail = (list: ListState, action: string, text: string, error: string): Reply => ({ kind: "reply", text, details: toDetails(list, action, error) });

const ok = (model: Model, action: Action, list: ListState, text: string): Reply => ({
	kind: "reply",
	text,
	details: toDetails(list, action),
	next: list === model.list ? model : makeModel(list, model.nudged),
});

const notFound = (list: ListState, action: Action, id: number): Reply => fail(list, action, `Task #${id} not found`, `#${id} not found`);

function listText(list: ListState): string {
	if (list.tasks.length === 0) return "No tasks defined yet.";
	const lines = list.tasks.map((t) => `[${STATUS_ICON[t.status]}] #${t.id} (${t.status}): ${t.text}`).join("\n");
	return list.title ? `${list.title}:\n${lines}` : lines;
}

/**
 * The whole tool behavior. Pure and synchronous.
 *
 * Without `consent`, new-list and clear return Ask while some task is not done. With `consent` (the user's answer; no UI, timeout
 * and decline all arrive as false) the result is always a Reply. L2 re-runs on
 * the current model after the dialog, which mirrors the original reading state
 * after its await.
 */
export function runTool(model: Model, params: Params): Ask | Reply;
export function runTool(model: Model, params: Params, consent: boolean): Reply;
export function runTool(model: Model, params: Params, consent?: boolean): Ask | Reply {
	const list = model.list;
	const v = validate(params);
	if (!v.ok) return fail(list, v.action, v.text, v.error);
	const cmd = v.cmd;
	const n = list.tasks.length;
	// Asking only protects unfinished work; a finished list is recoverable from the session branch.
	const open = list.tasks.filter((t) => t.status !== "done").length;

	switch (cmd.kind) {
		case "new-list": {
			if (open > 0) {
				if (consent === undefined) {
					return ask("Start a new list?", `This will replace${list.title ? ` "${list.title}"` : " the current list"} (${n} task(s), ${open} not done). Continue?`);
				}
				if (!consent) return fail(list, "new-list", "New list cancelled by user.", "cancelled");
			}
			const text = `New list: "${cmd.title}"${cmd.description ? ` — ${cmd.description}` : ""}`;
			return ok(model, "new-list", makeList([], 1, cmd.title, cmd.description), text);
		}
		case "list":
			return ok(model, "list", list, listText(list));
		case "add": {
			const added = cmd.items.map((text, i): Task => ({ id: list.nextId + i, text, status: "idle" }));
			const text =
				added.length === 1 ? `Added task #${added[0].id}: ${added[0].text}` : `Added ${added.length} tasks: ${added.map((t) => `#${t.id}`).join(", ")}`;
			return ok(model, "add", makeList([...list.tasks, ...added], list.nextId + added.length, list.title, list.description), text);
		}
		case "toggle": {
			const task = list.tasks.find((t) => t.id === cmd.id);
			if (!task) return notFound(list, "toggle", cmd.id);
			const next = NEXT_STATUS[task.status];
			const demoted: number[] = [];
			const tasks = list.tasks.map((t): Task => {
				if (t === task) return { ...t, status: next };
				if (next === "inprogress" && t.status === "inprogress") {
					demoted.push(t.id);
					return { ...t, status: "idle" };
				}
				return t;
			});
			let text = `Task #${task.id}: ${task.status} → ${next}`;
			if (demoted.length > 0) {
				text += `\n(Auto-paused ${demoted.map((id) => `#${id}`).join(", ")} → idle. Only one task can be in progress at a time.)`;
			}
			return ok(model, "toggle", makeList(tasks, list.nextId, list.title, list.description), text);
		}
		case "remove": {
			const task = list.tasks.find((t) => t.id === cmd.id);
			if (!task) return notFound(list, "remove", cmd.id);
			const tasks = list.tasks.filter((t) => t !== task);
			return ok(model, "remove", makeList(tasks, list.nextId, list.title, list.description), `Removed task #${task.id}: ${task.text}`);
		}
		case "update": {
			const task = list.tasks.find((t) => t.id === cmd.id);
			if (!task) return notFound(list, "update", cmd.id);
			const tasks = list.tasks.map((t): Task => (t === task ? { ...t, text: cmd.text } : t));
			return ok(model, "update", makeList(tasks, list.nextId, list.title, list.description), `Updated #${task.id}: "${task.text}" → "${cmd.text}"`);
		}
		case "clear": {
			if (open > 0) {
				if (consent === undefined) {
					return ask("Clear TillDone list?", `This will remove all ${n} task(s)${list.title ? ` from "${list.title}"` : ""}, ${open} not done. Continue?`);
				}
				if (!consent) return fail(list, "clear", "Clear cancelled by user.", "cancelled");
			}
			return ok(model, "clear", EMPTY_LIST, `Cleared ${n} task(s)`);
		}
	}
}

const ask = (title: string, message: string): Ask => ({ kind: "ask", title, message, timeoutMs: CONFIRM_TIMEOUT_MS });

// Gate

export type Verdict = { readonly block: false } | { readonly block: true; readonly reason: string };

// Reading changes nothing, and a plan often depends on it (e.g. a spec in a file).
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export function gate(model: Model, toolName: string): Verdict {
	if (toolName === TOOL.name || READ_ONLY_TOOLS.includes(toolName)) return { block: false };
	const { tasks } = model.list;
	if (tasks.length === 0) return { block: true, reason: GATE_REASON.noTasks };
	if (tasks.every((t) => t.status === "done")) return { block: true, reason: GATE_REASON.allDone };
	if (!tasks.some((t) => t.status === "inprogress")) return { block: true, reason: GATE_REASON.noneActive };
	return { block: false };
}

// Nudge latch: at most one nudge per user input

export interface Nudge {
	readonly customType: "tilldone-nudge";
	readonly content: string;
	readonly display: true;
}

export function agentEnd(model: Model): { readonly model: Model; readonly nudge?: Nudge } {
	const incomplete = model.list.tasks.filter((t) => t.status !== "done");
	if (incomplete.length === 0 || model.nudged) return { model };
	const lines = incomplete.map((t) => `  ${STATUS_ICON[t.status]} #${t.id} [${STATUS_LABEL[t.status]}]: ${t.text}`).join("\n");
	return {
		model: makeModel(model.list, true),
		nudge: {
			customType: "tilldone-nudge",
			content: `⚠️ You still have ${incomplete.length} incomplete task(s):\n\n${lines}\n\nEither continue working on them or mark them done with \`tilldone toggle\`. Don't stop until it's done!`,
			display: true,
		},
	};
}

export function userInput(model: Model): Model {
	return model.nudged ? makeModel(model.list, false) : model;
}

// Read-only selectors for L4

export function countByStatus(list: ListState): Readonly<Record<Status, number>> {
	const counts = { idle: 0, inprogress: 0, done: 0 };
	for (const t of list.tasks) counts[t.status]++;
	return counts;
}

/** The task the widget shows: the first one in progress. */
export function current(list: ListState): Task | undefined {
	return list.tasks.find((t) => t.status === "inprogress");
}
