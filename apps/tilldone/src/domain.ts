/**
 * TillDone Desk L3: pure RPC projection, intent rules, and JSON view models.
 * Imports only pure domain modules, including the extension's zero-dependency task domain.
 * Local desk_* records carry clock and transport facts supplied by L2.
 */
import { EMPTY_LIST, countByStatus, current, parseDetails, SPLIT_HINT_EVERY, STATUS_ICON, TOOL, type ListState } from "../extensions/tilldone/state.ts";

import { marked } from "marked";

import { DEFAULT_PREFERENCES, parsePreferences, copyFor, appearanceView, type Preferences } from "./appearance.ts";

import { INITIAL_API, apiView, API_PROVIDERS, isApiProvider, parseCredentialChanges, type ApiProvider, type ApiState, type CredentialChanges } from "./api-domain.ts";

// RPC is extensible; unknown records are deliberately ignored by this projection.
export type RecordValue = Record<string, any>;
/**
 * The task in progress when a message or tool began. Task ids restart when a list is replaced,
 * so the stamp also names which list (State.listEpoch) the id belongs to.
 */
export interface TaskStamp { readonly list: number; readonly id: number }
export interface Message {
	readonly id: string;
	readonly kind: "assistant" | "user" | "nudge" | "notice";
	readonly blocks: Readonly<Record<number, string>>;
	readonly images: number;
	readonly error: string;
	readonly task: TaskStamp | null;
	/** Only on nudge messages. */
	readonly nudge?: Nudge;
}
/**
 * A TillDone nudge and what came of it. The tasks still open when it arrived are judged at the next agent_end,
 * the end of the run the nudge started. Task ids only mean the same tasks within one list (State.listEpoch).
 */
export interface Nudge {
	readonly no: number;
	readonly list: number;
	readonly pending: readonly number[];
	readonly outcome: "waiting" | "done" | "partial" | "stopped" | "replaced";
	readonly left: readonly number[];
}
/** A pasted image as the renderer sends it; Pi resizes oversized ones before they reach the model. */
export interface Image { readonly mimeType: string; readonly data: string }
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 10;
/** Base64 length of a 20 MB file: a sanity bound, not the model limit. */
const MAX_IMAGE_BASE64 = Math.ceil((20 * 1024 * 1024) / 3) * 4;
export interface Tool {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
	readonly result: unknown;
	readonly phase: "running" | "done" | "error";
	readonly startedAt: number;
	readonly task: TaskStamp | null;
}
/** A question an extension is blocked on: Pi's four RPC dialog methods. */
export type DialogKind = "confirm" | "select" | "input" | "editor";
export interface Dialog {
	readonly id: string;
	readonly kind: DialogKind;
	readonly title: string;
	/** confirm only. */
	readonly message: string;
	/** select only. */
	readonly options: readonly string[];
	/** input: a hint inside the empty field; editor: the starting text. */
	readonly placeholder: string;
	readonly prefill: string;
	readonly deadline: number | null;
}
const DIALOG_KINDS: readonly string[] = ["confirm", "select", "input", "editor"];
/** Bounds on what an extension may ask, so a broken request cannot flood the window. */
const MAX_OPTIONS = 200;
const MAX_ANSWER = 100000;
function selectOptions(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS || !raw.every((o) => typeof o === "string")) return;
	return raw;
}
export interface State {
	readonly list: ListState;
	/** Counts list replacements (new-list, clear), the moments task ids restart. */
	readonly listEpoch: number;
	/** The conversation shows only this task's activity; ignored once the task leaves the list. */
	readonly taskFilter: TaskStamp | null;
	readonly messages: readonly Message[];
	readonly tools: readonly Tool[];
	readonly timeline: readonly { kind: "message" | "tool"; id: string }[];
	readonly assistantId: string | null;
	readonly sequence: number;
	/** Waiting extension dialogs, shown one at a time in arrival order. */
	readonly dialogs: readonly Dialog[];
	/**
	 * pstack Poteto Mode. With pstack loaded (TILLDONE_PSTACK=1) every session runs in it: the session's first idle prompt
	 * carries the skill prefix, and pstack keeps the mode for the rest of the session. `on` means this session has been switched on.
	 */
	readonly poteto: { readonly available: boolean; readonly on: boolean };
	/** Pi's steering and follow-up queues: messages accepted but not yet delivered to the model. */
	readonly queued: readonly string[];
	/** Tasks whose split button was pressed and whose split has not landed yet. */
	readonly pendingSplits: readonly number[];
	/** Non-tilldone tools started while each task was in progress, the same calls the extension's split hint counts. */
	readonly toolCalls: Readonly<Record<number, number>>;
	/** Turns, one model request each, started while each task was in progress. */
	readonly modelCalls: Readonly<Record<number, number>>;
	readonly now: number;
	/** When the current run began; null while idle. */
	readonly runStartedAt: number | null;
	/** Since when the model has been working on its next step: a new turn or the end of a tool. */
	readonly turnAt: number;
	/** Arrival of the last Pi record that shows progress; the state poll does not count. */
	readonly activityAt: number;
	readonly runActive: boolean;
	readonly streaming: boolean;
	readonly compacting: boolean;
	readonly model: string;
	readonly imageInput: boolean;
	readonly thinking: string;
	readonly cwd: string;
	/** The file Pi saves this session to, as get_state reports it; Restart resumes it after a crash. */
	readonly sessionFile: string;
	readonly connection: "starting" | "ready" | "exited";
	readonly error: string;
	readonly diagnostics: string;
	readonly taskFocus: number;
	readonly preferences: Preferences;
	readonly systemDark: boolean;
	readonly api: ApiState;
}
export function initialState(model: string, cwd: string, preferences = DEFAULT_PREFERENCES, systemDark = false, pstack = false): State {
	return { list: EMPTY_LIST, listEpoch: 0, taskFilter: null, messages: [], tools: [], timeline: [], assistantId: null, sequence: 0,
		poteto: { available: pstack, on: false }, dialogs: [], now: 0, runStartedAt: null, turnAt: 0, activityAt: 0, runActive: false, streaming: false, compacting: false,
		queued: [], pendingSplits: [], toolCalls: {}, modelCalls: {}, model, imageInput: false, thinking: "unknown", cwd, sessionFile: "", connection: "starting", error: "", diagnostics: "", taskFocus: 0, preferences, systemDark, api: INITIAL_API };
}
const text = (value: unknown): string => typeof value === "string" ? value : "";
function contentBlocks(content: any): Record<number, string> {
	if (typeof content === "string") return { 0: content };
	return Object.fromEntries((Array.isArray(content) ? content : []).flatMap((block, index) => block?.type === "text" ? [[index, text(block.text)]] : []));
}
const imageCount = (content: any): number => Array.isArray(content) ? content.filter((block) => block?.type === "image").length : 0;
function stampTask(state: State): TaskStamp | null {
	const active = current(state.list);
	return active ? { list: state.listEpoch, id: active.id } : null;
}
function addMessage(state: State, kind: Message["kind"], blocks: Record<number, string>, error = "", images = 0): State {
	const id = `message-${state.sequence + 1}`;
	return { ...state, sequence: state.sequence + 1,
		messages: [...state.messages, { id, kind, blocks, images, error, task: stampTask(state) }],
		timeline: [...state.timeline, { kind: "message", id }],
		...(kind === "assistant" ? { assistantId: id } : {}) };
}
function updateAssistant(state: State, change: (message: Message) => Message): State {
	return { ...state, messages: state.messages.map((m) => m.id === state.assistantId ? change(m) : m) };
}
export function isRunning(state: State): boolean {
	return state.runActive || state.streaming || state.compacting;
}
/** False when next renders the same view as previous: identical, or only the clock moved with no dialog counting down. */
export function viewChanged(previous: State, next: State): boolean {
	if (previous === next) return false;
	if (next.dialogs.length) return true;
	for (const key of Object.keys(next) as (keyof State)[]) if (key !== "now" && previous[key] !== next[key]) return true;
	// While running, the activity bar's timers are part of the view.
	if (!isRunning(next)) return false;
	const ui = copyFor(next.preferences.language);
	return JSON.stringify(activityView(previous, ui)) !== JSON.stringify(activityView(next, ui));
}

type Counts = Readonly<Record<number, number>>;
/** Adds one to the task in progress, if any. */
function countActive(counts: Counts, list: ListState): Counts {
	const active = current(list);
	return active ? { ...counts, [active.id]: (counts[active.id] ?? 0) + 1 } : counts;
}
/** Ids only restart when a list is replaced (new-list, clear), so a lower nextId means old ids belong to other tasks. */
const replacesList = (previous: ListState, list: ListState): boolean => list.nextId < previous.nextId;
function keepCounts(counts: Counts, previous: ListState, list: ListState): Counts {
	if (replacesList(previous, list)) return {};
	const kept = Object.entries(counts).filter(([id]) => list.tasks.some((t) => t.id === Number(id)));
	return kept.length === Object.keys(counts).length ? counts : Object.fromEntries(kept);
}
/** A task counts as open while it, or any subtask a split replaced it with, is not done. */
function stillOpen(list: ListState, id: number, seen: ReadonlySet<number> = new Set()): boolean {
	const task = list.tasks.find((t) => t.id === id);
	if (task) return task.status !== "done";
	return list.tasks.some((t) => t.from === id && !seen.has(t.id) && stillOpen(list, t.id, new Set([...seen, id])));
}
function addNudge(state: State, blocks: Record<number, string>): State {
	const no = state.messages.filter((m) => m.nudge).length + 1;
	const pending = state.list.tasks.filter((t) => t.status !== "done").map((t) => t.id);
	const s = addMessage(state, "nudge", blocks);
	const nudge: Nudge = { no, list: state.listEpoch, pending, outcome: "waiting", left: pending };
	return { ...s, messages: s.messages.map((m, i) => i === s.messages.length - 1 ? { ...m, nudge } : m) };
}
function judgeNudges(state: State): State {
	if (!state.messages.some((m) => m.nudge?.outcome === "waiting")) return state;
	return { ...state, messages: state.messages.map((m) => {
		if (m.nudge?.outcome !== "waiting") return m;
		if (m.nudge.list !== state.listEpoch) return { ...m, nudge: { ...m.nudge, outcome: "replaced", left: [] } };
		const left = m.nudge.pending.filter((id) => stillOpen(state.list, id));
		const outcome = left.length === 0 ? "done" : left.length === m.nudge.pending.length ? "stopped" : "partial";
		return { ...m, nudge: { ...m.nudge, outcome, left } };
	}) };
}
/** Every Pi record except the state poll's response proves Pi is still making progress. */
export function reduce(state: State, record: RecordValue): State {
	const next = project(state, record);
	if (typeof record.type !== "string" || record.type.startsWith("desk_") || record.type === "response" || next.activityAt === next.now) return next;
	return { ...next, activityAt: next.now };
}
function project(state: State, record: RecordValue): State {
	switch (record.type) {
		case "desk_api_summary": return { ...state, api: { ...state.api, summary: record.summary } };
		case "desk_api_open": return { ...state, api: { ...state.api, open: true, error: null, saved: false } };
		case "desk_api_close": return { ...state, api: { ...state.api, open: false, error: null } };
		case "desk_api_saving": return { ...state, api: { ...state.api, saving: true, error: null, saved: false } };
		case "desk_api_error": return { ...state, api: { ...state.api, saving: false, error: record.error, saved: false } };
		case "desk_api_saved": return { ...state, api: { ...state.api, saving: false, error: null, summary: record.summary, savedRevision: state.api.savedRevision + 1, saved: true } };
		case "desk_tick": {
			const dialogs = state.dialogs.filter((d) => d.deadline === null || d.deadline > record.now);
			return { ...state, now: record.now, dialogs: dialogs.length === state.dialogs.length ? state.dialogs : dialogs };
		}
		case "desk_preferences": {
			const preferences = parsePreferences(record.preferences);
			return preferences ? { ...state, preferences } : state;
		}
		case "desk_system_theme": return { ...state, systemDark: record.dark === true };
		case "desk_focus_tasks": return { ...state, taskFocus: state.taskFocus + 1 };
		case "desk_poteto_on": return { ...state, poteto: { ...state.poteto, on: true } };
		case "desk_dialog_closed": return { ...state, dialogs: state.dialogs.filter((d) => d.id !== record.id) };
		case "desk_error": return { ...state, error: text(record.error) };
		case "desk_stderr": return { ...state, diagnostics: (state.diagnostics + text(record.text)).slice(-8000) };
		case "desk_exit": return { ...state, connection: "exited", error: text(record.error), runStartedAt: null, runActive: false, streaming: false, compacting: false, dialogs: [], queued: [], pendingSplits: [] };
		case "desk_resume_unavailable": return addMessage(state, "notice", { 0: copyFor(state.preferences.language).resumeUnavailable });
		case "desk_split_requested": return { ...state, pendingSplits: [...state.pendingSplits, record.id] };
		case "desk_filter_task": return { ...state, taskFilter: record.id === null ? null : { list: state.listEpoch, id: record.id } };
		case "queue_update": {
			const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string");
			if (!strings(record.steering) || !strings(record.followUp)) return state;
			return { ...state, queued: [...record.steering, ...record.followUp] };
		}
		case "response": {
			if (!record.success) return { ...state, error: `${record.command}: ${text(record.error)}` };
			if (record.command !== "get_state" || !record.data) return state;
			const data = record.data;
			const model = data.model ? `${data.model.provider}/${data.model.id}` : state.model;
			const thinking = text(data.thinkingLevel) || "unknown", streaming = data.isStreaming === true, compacting = data.isCompacting === true;
			const imageInput = data.model ? Array.isArray(data.model.input) && data.model.input.includes("image") : state.imageInput;
			const sessionFile = text(data.sessionFile);
			// The 2 s state poll usually reports nothing new; keep identity so L2 can skip publishing.
			if (state.connection === "ready" && state.model === model && state.imageInput === imageInput && state.thinking === thinking && state.streaming === streaming && state.compacting === compacting && state.sessionFile === sessionFile) return state;
			return { ...state, connection: "ready", model, imageInput, thinking, streaming, compacting, sessionFile };
		}
		case "agent_start": return { ...state, runActive: true, error: "", runStartedAt: state.runStartedAt ?? state.now, turnAt: state.now };
		// One turn is one model request; it belongs to the task in progress when it starts.
		case "turn_start": return { ...state, turnAt: state.now, modelCalls: countActive(state.modelCalls, state.list) };
		// agent_end is intentionally not an idle transition: a nudge may start another run.
		case "agent_end": return judgeNudges(state);
		case "agent_settled": return { ...state, runStartedAt: null, runActive: false, streaming: false, compacting: false, queued: [], pendingSplits: [] };
		case "thinking_level_changed": return { ...state, thinking: text(record.level) };
		case "message_start": {
			const m = record.message;
			if (m?.role === "assistant") return addMessage(state, "assistant", contentBlocks(m.content));
			if (m?.role === "user") return addMessage(state, "user", contentBlocks(m.content), "", imageCount(m.content));
			if (m?.role === "custom" && m.customType === "tilldone-nudge") return addNudge(state, contentBlocks(m.content));
			return state;
		}
		case "message_update": {
			const event = record.assistantMessageEvent;
			if (!event || !["text_start", "text_delta", "text_end"].includes(event.type)) return state;
			const s = state.assistantId ? state : addMessage(state, "assistant", {});
			return updateAssistant(s, (m) => ({ ...m, blocks: { ...m.blocks, [event.contentIndex]: event.type === "text_delta"
				? (m.blocks[event.contentIndex] ?? "") + text(event.delta)
				: event.type === "text_end" ? text(event.content) : "" } }));
		}
		case "message_end": {
			if (record.message?.role !== "assistant") return state;
			const s = state.assistantId ? state : addMessage(state, "assistant", {});
			return { ...updateAssistant(s, (m) => ({ ...m, blocks: contentBlocks(record.message.content), error: text(record.message.errorMessage) })), assistantId: null };
		}
		case "tool_execution_start": {
			const tool: Tool = { id: record.toolCallId, name: record.toolName, args: record.args ?? null, result: null, phase: "running", startedAt: state.now, task: stampTask(state) };
			const toolCalls = record.toolName === TOOL.name ? state.toolCalls : countActive(state.toolCalls, state.list);
			return { ...state, toolCalls, tools: [...state.tools, tool], timeline: [...state.timeline, { kind: "tool", id: tool.id }] };
		}
		case "tool_execution_update":
			return { ...state, tools: state.tools.map((t) => t.id === record.toolCallId ? { ...t, result: record.partialResult } : t) };
		case "tool_execution_end": {
			const list = record.toolName === "tilldone" ? parseDetails(record.result?.details) ?? state.list : state.list;
			// A pending split is resolved once its task is gone from the list (split replaces it) or done.
			const pendingSplits = list === state.list ? state.pendingSplits : state.pendingSplits.filter((id) => list.tasks.some((t) => t.id === id && t.status !== "done"));
			const counts = list === state.list ? state : { toolCalls: keepCounts(state.toolCalls, state.list, list), modelCalls: keepCounts(state.modelCalls, state.list, list) };
			const listEpoch = replacesList(state.list, list) ? state.listEpoch + 1 : state.listEpoch;
			return { ...state, turnAt: state.now, list, listEpoch, pendingSplits, toolCalls: counts.toolCalls, modelCalls: counts.modelCalls, tools: state.tools.map((t) => t.id === record.toolCallId
				? { ...t, result: record.result, phase: record.isError ? "error" : "done" } : t) };
		}
		case "extension_ui_request": {
			if (DIALOG_KINDS.includes(record.method)) {
				const options = record.method === "select" ? selectOptions(record.options) : [];
				// An unusable select was already cancelled by immediateUIResponse.
				if (!options) return state;
				return { ...state, dialogs: [...state.dialogs, {
					id: record.id, kind: record.method, title: text(record.title), message: record.method === "confirm" ? text(record.message) : "",
					options, placeholder: record.method === "input" ? text(record.placeholder) : "", prefill: record.method === "editor" ? text(record.prefill) : "",
					deadline: typeof record.timeout === "number" ? state.now + Math.max(0, record.timeout) : null,
				}] };
			}
			if (record.method === "notify") return addMessage(state, "notice", { 0: text(record.message) });
			return state;
		}
		case "extension_error": return { ...state, error: text(record.error) };
		default: return state;
	}
}

export type Intent = { type: "submit"; message: string; images?: readonly Image[] }
	| { type: "abort" | "restart" | "newSession" | "focusTasks" }
	| { type: "confirm"; id: string; confirmed: boolean }
	/** Answers a select, input or editor dialog; null cancels it. */
	| { type: "answer"; id: string; value: string | null }
	| { type: "splitTask"; id: number }
	/** Shows only one task's activity; null shows everything. */
	| { type: "filterTask"; id: number | null }
	| { type: "copyMessage"; id: string }
	/** reveal: show a local file in Finder instead of opening it. */
	| { type: "openLink"; id: string; url: string; reveal?: boolean }
	| { type: "preferences"; preferences: Preferences }
	| { type: "apiOpen" | "apiClose" }
	| { type: "apiLink"; provider: ApiProvider }
	| { type: "apiSave"; result: ReturnType<typeof parseCredentialChanges> };
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
function parseImages(raw: unknown): Image[] | undefined {
	if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return;
	const images: Image[] = [];
	for (const image of raw) {
		if (!IMAGE_TYPES.includes(image?.mimeType) || typeof image.data !== "string" || !image.data || image.data.length > MAX_IMAGE_BASE64 || !BASE64.test(image.data)) return;
		images.push({ mimeType: image.mimeType, data: image.data });
	}
	return images;
}
export function parseIntent(raw: unknown): Intent | undefined {
	if (!raw || typeof raw !== "object") return;
	const r = raw as RecordValue;
	if (r.type === "apiOpen" || r.type === "apiClose") return { type: r.type };
	if (r.type === "apiLink" && isApiProvider(r.provider)) return { type: "apiLink", provider: r.provider };
	if (r.type === "apiSave") return { type: "apiSave", result: parseCredentialChanges(r.providers) };
	if (["abort", "restart", "newSession", "focusTasks"].includes(r.type)) return { type: r.type } as Intent;
	if (r.type === "submit" && typeof r.message === "string" && r.message.length <= 100000) {
		const images = parseImages(r.images ?? []);
		return images && { type: "submit", message: r.message, images };
	}
	if (r.type === "preferences") {
		const preferences = parsePreferences(r.preferences);
		if (preferences) return { type: "preferences", preferences };
	}
	if (r.type === "splitTask" && Number.isInteger(r.id) && r.id > 0) return { type: "splitTask", id: r.id };
	if (r.type === "filterTask" && (r.id === null || (Number.isInteger(r.id) && r.id > 0))) return { type: "filterTask", id: r.id };
	if (r.type === "copyMessage" && typeof r.id === "string" && r.id.length > 0 && r.id.length <= 64) return { type: "copyMessage", id: r.id };
	if (r.type === "openLink" && typeof r.id === "string" && r.id.length > 0 && r.id.length <= 64 && typeof r.url === "string" && r.url.length > 0 && r.url.length <= 2048) {
		return { type: "openLink", id: r.id, url: r.url, ...(typeof r.reveal === "boolean" ? { reveal: r.reveal } : {}) };
	}
	if (r.type === "confirm" && typeof r.id === "string" && typeof r.confirmed === "boolean") return { type: "confirm", id: r.id, confirmed: r.confirmed };
	if (r.type === "answer" && typeof r.id === "string" && (r.value === null || (typeof r.value === "string" && r.value.length <= MAX_ANSWER))) return { type: "answer", id: r.id, value: r.value };
}
export function planIntent(state: State, intent: Intent): { commands: RecordValue[]; events: RecordValue[]; restart?: "resume" | "fresh"; saveApi?: CredentialChanges; externalUrl?: string; localFile?: LocalFile; clipboard?: string } {
	const empty = { commands: [], events: [] };
	if (intent.type === "apiOpen") return { commands: [], events: [{ type: "desk_api_open" }] };
	if (intent.type === "apiClose") return state.api.saving ? empty : { commands: [], events: [{ type: "desk_api_close" }] };
	if (intent.type === "apiLink") return { ...empty, externalUrl: API_PROVIDERS.find((p) => p.id === intent.provider)!.url };
	if (intent.type === "apiSave") {
		if (state.api.saving) return empty;
		const error = "error" in intent.result ? intent.result.error : state.api.summary.error ?? (!state.api.summary.authPath ? "loadFailed" : null);
		if (error) return { commands: [], events: [{ type: "desk_api_error", error }] };
		if ("changes" in intent.result) return { ...empty, saveApi: intent.result.changes };
		return empty;
	}
	if (intent.type === "focusTasks" || (intent.type === "submit" && intent.message.trim() === "/tilldone")) {
		return { commands: [], events: [{ type: "desk_focus_tasks" }] };
	}
	if (intent.type === "preferences") return { commands: [], events: [{ type: "desk_preferences", preferences: intent.preferences }] };
	// A view-only choice: it works while Pi is busy or gone. Picking the task already shown goes back to everything.
	if (intent.type === "filterTask") {
		if (intent.id !== null && !state.list.tasks.some((t) => t.id === intent.id)) return empty;
		const id = intent.id !== null && intent.id === activeFilter(state)?.id ? null : intent.id;
		return { commands: [], events: [{ type: "desk_filter_task", id }] };
	}
	// Restart follows a crash or exit, so it resumes the session Pi was saving.
	if (intent.type === "restart") return state.connection === "exited" ? { ...empty, restart: "resume" } : empty;
	// The renderer names a message; the text comes from state, so it is the reply's Markdown source as Pi sent it.
	if (intent.type === "copyMessage") {
		const message = state.messages.find((m) => m.id === intent.id);
		return message && copyable(message) ? { ...empty, clipboard: messageText(message) } : empty;
	}
	// The renderer reports the address it shows; it opens only if this reply's own Markdown links to it.
	if (intent.type === "openLink") {
		const message = state.messages.find((m) => m.id === intent.id && m.kind === "assistant");
		if (!message || !linksIn(messageText(message)).includes(intent.url)) return empty;
		if (openableUrl(intent.url)) return { ...empty, externalUrl: intent.url };
		const path = localPath(intent.url);
		return path ? { ...empty, localFile: { path, reveal: intent.reveal === true || !OPENABLE_FILE.test(path) } } : empty;
	}
	// A new session is a fresh Pi process with a new session file; mid-run, Stop first.
	if (intent.type === "newSession") return state.connection === "ready" && !isRunning(state) ? { ...empty, restart: "fresh" } : empty;
	if (state.connection !== "ready") return empty;
	if (intent.type === "confirm" || intent.type === "answer") {
		const dialog = state.dialogs.find((d) => d.id === intent.id && (d.deadline === null || d.deadline > state.now));
		if (!dialog || (dialog.kind === "confirm") !== (intent.type === "confirm")) return empty;
		const closed = [{ type: "desk_dialog_closed", id: intent.id }];
		if (intent.type === "confirm") return { commands: [{ type: "extension_ui_response", id: intent.id, confirmed: intent.confirmed }], events: closed };
		if (intent.value === null) return { commands: [{ type: "extension_ui_response", id: intent.id, cancelled: true }], events: closed };
		// A select answer must be one of the offered options, exactly.
		if (dialog.kind === "select" && !dialog.options.includes(intent.value)) return empty;
		return { commands: [{ type: "extension_ui_response", id: intent.id, value: intent.value }], events: closed };
	}
	// The shepherd points at a task; the model, which has the context, decides the subtasks.
	if (intent.type === "splitTask") {
		const task = state.list.tasks.find((t) => t.id === intent.id && t.status !== "done");
		if (!task || state.pendingSplits.includes(task.id)) return empty;
		const message = copyFor(state.preferences.language).splitRequest.replaceAll("{id}", String(task.id)).replace("{text}", task.text);
		return { commands: [{ type: isRunning(state) ? "steer" : "prompt", message }], events: [{ type: "desk_split_requested", id: task.id }] };
	}
	if (intent.type === "abort") return { commands: [{ type: "clear_queue" }, { type: "abort" }], events: [] };
	if (intent.type === "submit") {
		const images = intent.images ?? [];
		if (!intent.message.trim() && !images.length) return empty;
		if (images.length && !state.imageInput) return empty;
		// While running, a message always steers: the user is redirecting the work in progress.
		const message = intent.message.trim();
		const command: RecordValue = { type: isRunning(state) ? "steer" : "prompt", message };
		if (images.length) command.images = images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
		// With pstack, the session's first idle prompt turns Poteto Mode on through pstack's own skill command.
		// Steers and other slash commands go through unchanged; a hand-typed /skill:poteto-mode counts as switching on.
		const { available, on } = state.poteto;
		if (available && !on && command.type === "prompt") {
			if (POTETO_SKILL.test(message)) return { commands: [command], events: [{ type: "desk_poteto_on" }] };
			if (!message.startsWith("/")) {
				command.message = message ? `/skill:poteto-mode ${message}` : "/skill:poteto-mode";
				return { commands: [command], events: [{ type: "desk_poteto_on" }] };
			}
		}
		return { commands: [command], events: [] };
	}
	return empty;
}
/** A select with no usable options cannot be answered, so Pi gets a cancel instead of waiting forever. */
export function immediateUIResponse(record: RecordValue): RecordValue | undefined {
	if (record.type === "extension_ui_request" && record.method === "select" && !selectOptions(record.options)) {
		return { type: "extension_ui_response", id: record.id, cancelled: true };
	}
}
function dialogView(dialog: Dialog, now: number) {
	const { deadline, ...shown } = dialog;
	return { ...shown, remainingSeconds: deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)) };
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
export type Entry = { id: string; kind: Message["kind"] | "tool"; label: string; text: string; images: number; error: string; args: string; result: string; copyable: boolean;
	/** Nudges only: what the nudge was about and what came of it, in the interface language. */
	summary: string; outcome: string; outcomeTone: "" | Nudge["outcome"] };
// Messages and tools are immutable, so an entry stays valid while its source object and copy are unchanged.
// Without this, every streamed token re-serializes the whole history, including every tool result.
const entries = new WeakMap<Message | Tool, { ui: ReturnType<typeof copyFor>; entry: Entry }>();
function entryFor(source: Message | Tool, ui: ReturnType<typeof copyFor>, build: () => Entry): Entry {
	const cached = entries.get(source);
	if (cached?.ui === ui) return cached.entry;
	const entry = build();
	entries.set(source, { ui, entry });
	return entry;
}
function toolCallsView(count: number, ui: ReturnType<typeof copyFor>) {
	const label = count === 0 ? "" : count === 1 ? ui.toolCallOne : ui.toolCalls.replace("{n}", String(count));
	return { toolCalls: count, toolCallsLabel: label, toolCallsTitle: ui.toolCallsTitle.replace("{every}", String(SPLIT_HINT_EVERY)), heavy: count >= SPLIT_HINT_EVERY };
}
function modelCallsView(count: number, ui: ReturnType<typeof copyFor>) {
	const label = count === 0 ? "" : count === 1 ? ui.modelCallOne : ui.modelCalls.replace("{n}", String(count));
	return { modelCalls: count, modelCallsLabel: label, modelCallsTitle: ui.modelCallsTitle };
}
/** Plain web addresses only: no other schemes, and no user:password@ that could disguise the real host. */
function openableUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
	} catch { return false; }
}
export interface LocalFile { readonly path: string; readonly reveal: boolean }
/**
 * An absolute path, a home-relative one, a file URL on this machine, or a path relative to Pi's working directory
 * (where the agent wrote its files). The path stays as written; L2 expands "~/" and resolves relative paths.
 */
function localPath(href: string): string | null {
	if ((href.startsWith("/") && !href.startsWith("//")) || href.startsWith("~/")) return href;
	try {
		const url = new URL(href);
		return url.protocol === "file:" && (url.host === "" || url.host === "localhost") ? decodeURIComponent(url.pathname) : null;
	} catch {
		return /^(?:\/\/|#|\?)/.test(href) ? null : href;
	}
}
// Only documents and media open in their default app. Apps, scripts and unknown types could run code, so they are shown in Finder.
const OPENABLE_FILE = /\.(pdf|png|jpe?g|gif|webp|heic|svg|txt|md|csv|tsv|json|log|html?|docx?|xlsx?|pptx?|key|pages|numbers|mp3|m4a|wav|mp4|mov)$/i;
/** Link targets as the renderer's Markdown shows them: the same marked lexer, so addresses compare exactly. */
function linksIn(source: string): string[] {
	const hrefs: string[] = [];
	marked.walkTokens(marked.lexer(source), (token) => { if (token.type === "link") hrefs.push(token.href); });
	return hrefs;
}
const messageText = (m: Message) => Object.entries(m.blocks).sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value).join("\n");
const POTETO_SKILL = /^\/skill:poteto-mode(?:\s|$)/;
// Pi expands `/skill:name args` into the whole skill file plus args; show what the user typed instead.
const EXPANDED_SKILL = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>(?:\n\n)?/;
export function collapseSkill(text: string): string {
	const match = EXPANDED_SKILL.exec(text);
	if (!match) return text;
	const rest = text.slice(match[0].length);
	return rest ? `/skill:${match[1]} ${rest}` : `/skill:${match[1]}`;
}
const shownText = (m: Message) => m.kind === "user" ? collapseSkill(messageText(m)) : messageText(m);
const copyable = (m: Message) => m.kind === "assistant" && messageText(m).trim() !== "";
const isSilentAssistant = (m: Message) => m.kind === "assistant" && !m.error && Object.values(m.blocks).every((value) => !value.trim());
/** What the run is doing right now, derived from state; never stored. */
export type Activity = { kind: "idle" } | { kind: "compacting"; since: number } | { kind: "thinking"; since: number }
	| { kind: "tool"; name: string; detail: string; since: number }
	| { kind: "subagents"; since: number; children: readonly Child[] };
/** One pstack subagent child as its latest partial result describes it. */
export interface Child {
	readonly agent: string;
	readonly model: string;
	readonly status: "pending" | "running" | "done" | "failed";
	readonly turns: number;
	readonly tokens: number;
	readonly startedAt: number;
	readonly lastAt: number;
	/** The child's latest tool call as "name: key arg", else its latest text. */
	readonly last: string;
	/** Subagents the child itself is waiting on; their own activity is invisible. */
	readonly nested: number;
}
const SUBAGENT_TOOL = "subagent";
const STALE_RUN_MS = 60_000, STALE_CHILD_MS = 120_000;
const isObject = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const oneLine = (value: string, max = 80): string => {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
/** The argument that says what a call is about: bash → command, read/edit/write → path, else nothing. */
function toolDetail(name: string, args: unknown): string {
	if (!isObject(args)) return "";
	if (name === "bash") return oneLine(text(args.command));
	if (name === "read" || name === "edit" || name === "write") return oneLine(text(args.path));
	return "";
}
/** How many agents one subagent call delegates to: parallel tasks, chain steps, or one. */
const delegated = (args: unknown): number => isObject(args) && Array.isArray(args.tasks) && args.tasks.length ? args.tasks.length
	: isObject(args) && Array.isArray(args.chain) && args.chain.length ? args.chain.length : 1;
function parseChild(raw: unknown, toolStartedAt: number): Child | undefined {
	if (!isObject(raw) || typeof raw.agent !== "string") return;
	const messages = (Array.isArray(raw.messages) ? raw.messages : []).filter(isObject);
	const assistants = messages.filter((m) => m.role === "assistant");
	const latest = assistants.at(-1);
	const lastMessage = messages.at(-1);
	const exitCode = num(raw.exitCode);
	const failedReason = (reason: unknown) => reason === "error" || reason === "aborted";
	const status: Child["status"] = exitCode === -1 ? "pending"
		: failedReason(raw.stopReason) || failedReason(latest?.stopReason) || exitCode > 0 ? "failed"
		: lastMessage?.role === "assistant" && lastMessage.stopReason === "stop" ? "done" : "running";
	let last = "";
	for (const message of [...assistants].reverse()) {
		const blocks = (Array.isArray(message.content) ? message.content : []).filter(isObject);
		const call = blocks.filter((b) => b.type === "toolCall" && typeof b.name === "string").at(-1);
		const said = blocks.filter((b) => b.type === "text" && text(b.text).trim()).at(-1);
		if (call) { const detail = toolDetail(call.name, call.arguments); last = detail ? `${call.name}: ${detail}` : call.name; break; }
		if (said) { last = oneLine(text(said.text)); break; }
	}
	// Only a call still waiting for its result is delegation in progress.
	const waiting = lastMessage?.role === "assistant" && Array.isArray(lastMessage.content) ? lastMessage.content.filter((b: unknown) => isObject(b) && b.type === "toolCall" && b.name === SUBAGENT_TOOL) : [];
	const stamps = messages.map((m) => num(m.timestamp) + (m.role === "assistant" ? num(m.durationMs) : 0)).filter((t) => t > 0);
	const startedAt = messages.map((m) => num(m.timestamp)).find((t) => t > 0) ?? toolStartedAt;
	const usage = isObject(raw.usage) ? raw.usage : {};
	return { agent: raw.agent, model: text(raw.model), status, turns: num(usage.turns) || assistants.length,
		tokens: num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite),
		startedAt, lastAt: stamps.length ? Math.max(...stamps) : startedAt, last,
		nested: status === "running" ? waiting.reduce((sum: number, call: RecordValue) => sum + delegated(call.arguments), 0) : 0 };
}
// A tool's result only changes by replacing the tool, so its parsed children stay valid per object.
const childrenCache = new WeakMap<Tool, readonly Child[]>();
function childrenOf(tool: Tool): readonly Child[] {
	const cached = childrenCache.get(tool);
	if (cached) return cached;
	const results = isObject(tool.result) && isObject(tool.result.details) && Array.isArray(tool.result.details.results) ? tool.result.details.results : [];
	const children = results.flatMap((raw: unknown) => parseChild(raw, tool.startedAt) ?? []);
	childrenCache.set(tool, children);
	return children;
}
export function activity(state: State): Activity {
	if (!isRunning(state)) return { kind: "idle" };
	// Pi reports compaction through the poll only; the last Pi record is the closest start time.
	if (state.compacting) return { kind: "compacting", since: state.activityAt };
	// A tool an aborted run never finished belongs to that run, not this one.
	const running = state.tools.filter((t) => t.phase === "running" && t.startedAt >= (state.runStartedAt ?? 0));
	const subagent = running.filter((t) => t.name === SUBAGENT_TOOL).at(-1);
	if (subagent) return { kind: "subagents", since: subagent.startedAt, children: childrenOf(subagent) };
	const tool = running.at(-1);
	if (tool) return { kind: "tool", name: tool.name, detail: toolDetail(tool.name, tool.args), since: tool.startedAt };
	return { kind: "thinking", since: state.turnAt };
}
type Ui = ReturnType<typeof copyFor>;
function duration(ms: number, ui: Ui): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return ui.durationSeconds.replace("{s}", String(s));
	if (s < 3600) return ui.durationMinutes.replace("{m}", String(Math.floor(s / 60))).replace("{s}", String(s % 60));
	return ui.durationHours.replace("{h}", String(Math.floor(s / 3600))).replace("{m}", String(Math.floor(s / 60) % 60));
}
const tokenCount = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const CHILD_ICON: Record<Child["status"], string> = { pending: "○", running: "◐", done: "✓", failed: "✗" };
function childView(child: Child, now: number, ui: Ui) {
	const time = { pending: ui.childPending, running: ui.childRunning.replace("{d}", duration(now - child.startedAt, ui)),
		done: ui.childDone.replace("{d}", duration(child.lastAt - child.startedAt, ui)), failed: ui.childFailed }[child.status];
	const parts = [child.agent, child.model, time, child.turns ? ui.childTurns.replace("{n}", String(child.turns)) : "",
		child.tokens ? ui.childTokens.replace("{n}", tokenCount(child.tokens)) : "", child.last];
	return { agent: child.agent, status: child.status, icon: CHILD_ICON[child.status], text: parts.filter(Boolean).join(" · "),
		nested: child.nested === 0 ? "" : child.nested === 1 ? ui.childNestedOne : ui.childNested.replace("{n}", String(child.nested)),
		stale: child.status === "running" && now - child.lastAt >= STALE_CHILD_MS };
}
function activityText(now: Activity, ui: Ui): string {
	switch (now.kind) {
		case "idle": return "";
		case "compacting": return ui.nowCompacting;
		case "thinking": return ui.nowThinking;
		case "tool": return (now.detail ? ui.nowToolDetail : ui.nowTool).replace("{name}", now.name).replace("{detail}", now.detail);
		case "subagents": {
			const done = now.children.filter((c) => c.status === "done").length, failed = now.children.filter((c) => c.status === "failed").length;
			const counts = [done ? ui.nowDone.replace("{n}", String(done)) : "", failed ? ui.nowFailed.replace("{n}", String(failed)) : ""].filter(Boolean).join(ui.listSeparator);
			const waiting = now.children.length === 1 ? ui.nowSubagentOne : ui.nowSubagents.replace("{n}", String(now.children.length));
			return counts ? `${waiting}${ui.nowCounts.replace("{counts}", counts)}` : waiting;
		}
	}
}
function activityView(state: State, ui: Ui) {
	const now = activity(state);
	if (now.kind === "idle") return null;
	return { text: activityText(now, ui), elapsed: duration(state.now - now.since, ui),
		total: state.runStartedAt === null ? "" : ui.runTotal.replace("{d}", duration(state.now - state.runStartedAt, ui)),
		lastActivity: ui.lastActivity.replace("{d}", duration(state.now - state.activityAt, ui)),
		// Children report only when one of their messages ends, so a long child step is silence, not a hang.
		stale: state.now - state.activityAt >= (now.kind === "subagents" ? STALE_CHILD_MS : STALE_RUN_MS),
		children: now.kind === "subagents" ? now.children.map((c) => childView(c, state.now, ui)) : [] };
}
/** The filter as the view applies it: a task of the current list, else nothing. */
function activeFilter(state: State) {
	const filter = state.taskFilter;
	return filter && filter.list === state.listEpoch ? state.list.tasks.find((t) => t.id === filter.id) : undefined;
}
// What each tool means for the timeline. Unlisted tools are summarized by name.
type ToolKind = "read" | "change" | "bash" | "list" | "delegate";
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = { read: "read", edit: "change", write: "change", bash: "bash", [TOOL.name]: "list", [SUBAGENT_TOOL]: "delegate" };
/** Tools that only look: a group of nothing else fades into the background. */
const QUIET_TOOLS: ReadonlySet<string> = new Set(["read", TOOL.name, "ls", "grep", "find"]);
type Tone = "error" | "change" | "quiet" | "normal";
/** The first matching rule sets a group's emphasis. */
const TONES: readonly [Tone, (tools: readonly Tool[]) => boolean][] = [
	["error", (tools) => tools.some((t) => t.phase === "error")],
	["change", (tools) => tools.some((t) => TOOL_KINDS[t.name] === "change")],
	["quiet", (tools) => tools.every((t) => QUIET_TOOLS.has(t.name))],
];
const MAX_NAMED_FILES = 3;
const basename = (args: unknown): string => isObject(args) ? text(args.path).split(/[\\/]/).filter(Boolean).at(-1) ?? "" : "";
function filesPart(tools: readonly Tool[], one: string, many: string, ui: Ui): string | undefined {
	const files = [...new Set(tools.map((t) => basename(t.args)).filter(Boolean))];
	if (!files.length) return;
	if (files.length === 1) return one.replace("{file}", files[0]);
	const named = files.slice(0, MAX_NAMED_FILES).join(ui.fileSeparator) + (files.length > MAX_NAMED_FILES ? "…" : "");
	return many.replace("{n}", String(files.length)).replace("{files}", named);
}
function bashPart(tools: readonly Tool[], ui: Ui): string | undefined {
	const command = tools.map((t) => toolDetail(t.name, t.args)).find(Boolean);
	if (!command) return;
	return tools.length === 1 ? ui.groupBashOne.replace("{command}", command) : ui.groupBash.replace("{n}", String(tools.length)).replace("{command}", command);
}
const SUMMARIES: Readonly<Record<ToolKind, (tools: readonly Tool[], ui: Ui) => string | undefined>> = {
	read: (tools, ui) => filesPart(tools, ui.groupReadOne, ui.groupRead, ui),
	change: (tools, ui) => filesPart(tools, ui.groupChangeOne, ui.groupChange, ui),
	bash: bashPart,
	list: (_, ui) => ui.groupList,
	delegate: (_, ui) => ui.groupDelegate,
};
function otherPart(tools: readonly Tool[], ui: Ui): string {
	return tools.length === 1 ? tools[0].name : ui.groupOther.replace("{name}", tools[0].name).replace("{n}", String(tools.length));
}
function groupSummary(tools: readonly Tool[], ui: Ui): string {
	const byKind = new Map<string, Tool[]>();
	for (const tool of tools) {
		const key = TOOL_KINDS[tool.name] ?? `other:${tool.name}`;
		byKind.set(key, [...(byKind.get(key) ?? []), tool]);
	}
	const parts = [...byKind].map(([key, same]) => (SUMMARIES[key as ToolKind]?.(same, ui)) ?? otherPart(same, ui));
	const failed = tools.filter((t) => t.phase === "error").length;
	const status = [tools.some((t) => t.phase === "running") ? ui.toolRunning : "", failed ? ui.nowFailed.replace("{n}", String(failed)) : ""].filter(Boolean);
	return [parts.join(ui.groupSeparator), ...status].join(" · ");
}
function toolEntry(t: Tool, ui: Ui): Entry {
	return entryFor(t, ui, () => ({ id: t.id, kind: "tool", label: [t.name, toolDetail(t.name, t.args), { running: ui.toolRunning, done: ui.toolDone, error: ui.toolError }[t.phase]].filter(Boolean).join(" · "), text: "", images: 0, args: pretty(t.args), result: pretty(t.result), error: "", copyable: false, summary: "", outcome: "", outcomeTone: "" }));
}
const taskIds = (ids: readonly number[], ui: Ui) => ids.map((id) => `#${id}`).join(ui.idSeparator);
function nudgeOutcome(n: Nudge, ui: Ui): string {
	const left = taskIds(n.left, ui);
	return { waiting: ui.nudgeWaiting, done: ui.nudgeDone, replaced: ui.nudgeReplaced, stopped: ui.nudgeStopped.replace("{left}", left),
		partial: ui.nudgePartial.replace("{d}", String(n.pending.length - n.left.length)).replace("{n}", String(n.pending.length)).replace("{left}", left) }[n.outcome];
}
function messageEntry(m: Message, ui: Ui): Entry {
	return entryFor(m, ui, () => ({ id: m.id, kind: m.kind, label: m.nudge ? ui.nudgeNo.replace("{n}", String(m.nudge.no)) : { assistant: ui.assistant, user: ui.user, nudge: ui.nudge, notice: ui.notice }[m.kind],
		text: shownText(m), images: m.images, error: m.error, args: "", result: "", copyable: copyable(m),
		summary: m.nudge ? ui.nudgeSummary.replace("{n}", String(m.nudge.pending.length)).replace("{ids}", taskIds(m.nudge.pending, ui)) : "",
		outcome: m.nudge ? nudgeOutcome(m.nudge, ui) : "", outcomeTone: m.nudge?.outcome ?? "" }));
}
/** The session's nudges as one plain sentence for the task panel, zero included once there is a list; null while there is nothing to remind about. */
function nudgesView(state: State, ui: Ui) {
	const nudges = state.messages.filter((m) => m.nudge);
	if (!nudges.length && !state.list.tasks.length) return null;
	if (!nudges.length) {
		const finished = state.list.tasks.every((t) => t.status === "done");
		return { label: finished ? ui.nudgeLineNoneDone : ui.nudgeLineNone, title: ui.nudgeTitleZero, target: "" };
	}
	const latest = nudges[nudges.length - 1], n = latest.nudge!;
	const line = { waiting: ui.nudgeLineWaiting, done: ui.nudgeLineDone, partial: ui.nudgeLinePartial, stopped: nudges.length === 1 ? ui.nudgeLineStoppedOnce : ui.nudgeLineStopped, replaced: ui.nudgeLineReplaced }[n.outcome];
	return { label: line.replace("{n}", String(nudges.length)).replace("{left}", taskIds(n.left, ui)), title: ui.nudgeTitle, target: latest.id };
}
/** Pi has settled with open tasks after its nudge for the latest user message was spent: the shepherd's move. */
function handoffView(state: State, ui: Ui): string | null {
	if (isRunning(state) || state.connection === "exited") return null;
	const lastIndex = (match: (m: Message) => boolean) => { for (let i = state.messages.length - 1; i >= 0; i--) if (match(state.messages[i])) return i; return -1; };
	const lastNudge = lastIndex((m) => m.nudge !== undefined), lastUser = lastIndex((m) => m.kind === "user");
	const open = state.list.tasks.filter((t) => t.status !== "done").map((t) => t.id);
	if (lastNudge < 0 || lastNudge < lastUser || !open.length) return null;
	return ui.handoff.replace("{tasks}", taskIds(open, ui));
}
/** Consecutive tools with no visible message between them; the id is the first tool's, so it holds as the group grows. */
export interface ToolGroup { readonly kind: "tools"; readonly id: string; readonly summary: string; readonly tone: Tone; readonly open: boolean; readonly tools: readonly Entry[] }
function groupView(tools: readonly Tool[], ui: Ui): ToolGroup {
	return { kind: "tools", id: tools[0].id, summary: groupSummary(tools, ui), tone: TONES.find(([, matches]) => matches(tools))?.[0] ?? "normal",
		open: tools.some((t) => t.phase === "error"), tools: tools.map((t) => toolEntry(t, ui)) };
}
function conversationView(state: State, filter: number | null, ui: Ui): (Entry | ToolGroup)[] {
	const messages = new Map(state.messages.map((m) => [m.id, m]));
	const tools = new Map(state.tools.map((t) => [t.id, t]));
	const shows = (source: Message | Tool) => filter === null || (source.task?.list === state.listEpoch && source.task.id === filter);
	const items: (Entry | ToolGroup)[] = [];
	let run: Tool[] = [];
	const flush = () => { if (run.length) items.push(groupView(run, ui)); run = []; };
	for (const entry of state.timeline) {
		if (entry.kind === "tool") {
			const tool = tools.get(entry.id)!;
			if (shows(tool)) run.push(tool);
			continue;
		}
		const message = messages.get(entry.id)!;
		// A tool-only assistant turn carries no text, only the call the tool group already shows.
		if (!shows(message) || isSilentAssistant(message)) continue;
		flush();
		items.push(messageEntry(message, ui));
	}
	flush();
	return items;
}
export function toViewModel(state: State) {
	const ui = copyFor(state.preferences.language);
	const counts = countByStatus(state.list);
	const active = current(state.list);
	const filter = activeFilter(state);
	return {
		ui,
		api: apiView(state.api, state.preferences.language, state.model),
		appearance: appearanceView(state.preferences, state.systemDark),
		connection: state.connection, error: state.error, diagnostics: state.diagnostics,
		status: { model: state.model, thinking: state.thinking, running: isRunning(state), cwd: state.cwd },
		poteto: { available: state.poteto.available, active: state.poteto.on },
		input: { enabled: state.connection === "ready", running: isRunning(state), newSession: state.connection === "ready" && !isRunning(state), images: state.connection === "ready" && state.imageInput },
		tasks: { title: state.list.title ?? "TillDone", description: state.list.description ?? "", done: counts.done,
			total: state.list.tasks.length, progress: `${counts.done} / ${state.list.tasks.length} ${ui.done}`,
			current: active ? `${ui.working} #${active.id}: ${active.text}` : ui.noActive, focus: state.taskFocus, filterTitle: ui.filterTitle,
			items: state.list.tasks.map((t) => ({ ...t, label: t.from === undefined ? `#${t.id}` : `#${t.id} ← #${t.from}`, icon: STATUS_ICON[t.status], statusLabel: { idle: ui.taskIdle, inprogress: ui.taskInprogress, done: ui.taskDone }[t.status], current: t.id === active?.id,
				filtered: t.id === filter?.id, splittable: state.connection === "ready" && t.status !== "done", splitting: state.pendingSplits.includes(t.id),
				...toolCallsView(state.toolCalls[t.id] ?? 0, ui), ...modelCallsView(state.modelCalls[t.id] ?? 0, ui) })),
			nudges: nudgesView(state, ui) },
		handoff: handoffView(state, ui),
		queued: state.queued,
		activity: activityView(state, ui),
		filter: filter ? { label: ui.filterLabel.replace("{id}", String(filter.id)).replace("{text}", filter.text), clear: ui.filterClear } : null,
		conversation: conversationView(state, filter?.id ?? null, ui),
		dialog: state.dialogs.length ? dialogView(state.dialogs[0], state.now) : null,
	};
}
