/**
 * TillDone Desk L3: pure RPC projection, intent rules, and JSON view models.
 * Imports only pure domain modules, including the extension's zero-dependency task domain.
 * Local desk_* records carry clock and transport facts supplied by L2.
 */
import { EMPTY_LIST, countByStatus, current, parseDetails, SPLIT_HINT_EVERY, STATUS_ICON, TOOL, type ListState } from "../../../extensions/tilldone/state.ts";

import { DEFAULT_PREFERENCES, parsePreferences, copyFor, appearanceView, type Preferences } from "./appearance.ts";

import { INITIAL_API, apiView, API_PROVIDERS, isApiProvider, parseCredentialChanges, type ApiProvider, type ApiState, type CredentialChanges } from "./api-domain.ts";

// RPC is extensible; unknown records are deliberately ignored by this projection.
export type RecordValue = Record<string, any>;
export interface Message {
	readonly id: string;
	readonly kind: "assistant" | "user" | "nudge" | "notice";
	readonly blocks: Readonly<Record<number, string>>;
	readonly images: number;
	readonly error: string;
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
}
export interface Confirm {
	readonly id: string;
	readonly title: string;
	readonly message: string;
	readonly deadline: number | null;
}
export interface State {
	readonly list: ListState;
	readonly messages: readonly Message[];
	readonly tools: readonly Tool[];
	readonly timeline: readonly { kind: "message" | "tool"; id: string }[];
	readonly assistantId: string | null;
	readonly sequence: number;
	readonly confirms: readonly Confirm[];
	/** Pi's steering and follow-up queues: messages accepted but not yet delivered to the model. */
	readonly queued: readonly string[];
	/** Tasks whose split button was pressed and whose split has not landed yet. */
	readonly pendingSplits: readonly number[];
	/** Non-tilldone tools started while each task was in progress, the same calls the extension's split hint counts. */
	readonly toolCalls: Readonly<Record<number, number>>;
	readonly statuses: Readonly<Record<string, string>>;
	readonly now: number;
	readonly runActive: boolean;
	readonly streaming: boolean;
	readonly compacting: boolean;
	readonly model: string;
	readonly imageInput: boolean;
	readonly thinking: string;
	readonly cwd: string;
	readonly connection: "starting" | "ready" | "exited";
	readonly error: string;
	readonly diagnostics: string;
	readonly taskFocus: number;
	readonly preferences: Preferences;
	readonly systemDark: boolean;
	readonly api: ApiState;
}
export function initialState(model: string, cwd: string, preferences = DEFAULT_PREFERENCES, systemDark = false): State {
	return { list: EMPTY_LIST, messages: [], tools: [], timeline: [], assistantId: null, sequence: 0,
		confirms: [], statuses: {}, now: 0, runActive: false, streaming: false, compacting: false,
		queued: [], pendingSplits: [], toolCalls: {}, model, imageInput: false, thinking: "unknown", cwd, connection: "starting", error: "", diagnostics: "", taskFocus: 0, preferences, systemDark, api: INITIAL_API };
}
const text = (value: unknown): string => typeof value === "string" ? value : "";
function contentBlocks(content: any): Record<number, string> {
	if (typeof content === "string") return { 0: content };
	return Object.fromEntries((Array.isArray(content) ? content : []).flatMap((block, index) => block?.type === "text" ? [[index, text(block.text)]] : []));
}
const imageCount = (content: any): number => Array.isArray(content) ? content.filter((block) => block?.type === "image").length : 0;
function addMessage(state: State, kind: Message["kind"], blocks: Record<number, string>, error = "", images = 0): State {
	const id = `message-${state.sequence + 1}`;
	return { ...state, sequence: state.sequence + 1,
		messages: [...state.messages, { id, kind, blocks, images, error }],
		timeline: [...state.timeline, { kind: "message", id }],
		...(kind === "assistant" ? { assistantId: id } : {}) };
}
function updateAssistant(state: State, change: (message: Message) => Message): State {
	return { ...state, messages: state.messages.map((m) => m.id === state.assistantId ? change(m) : m) };
}
export function isRunning(state: State): boolean {
	return state.runActive || state.streaming || state.compacting;
}
/** False when next renders the same view as previous: identical, or only the clock moved with no confirm counting down. */
export function viewChanged(previous: State, next: State): boolean {
	if (previous === next) return false;
	if (next.confirms.length) return true;
	for (const key of Object.keys(next) as (keyof State)[]) if (key !== "now" && previous[key] !== next[key]) return true;
	return false;
}

/** Ids only restart when a list is replaced (new-list, clear), so a lower nextId means the old counts belong to other tasks. */
function keepCounts(state: State, list: ListState): State["toolCalls"] {
	if (list.nextId < state.list.nextId) return {};
	const kept = Object.entries(state.toolCalls).filter(([id]) => list.tasks.some((t) => t.id === Number(id)));
	return kept.length === Object.keys(state.toolCalls).length ? state.toolCalls : Object.fromEntries(kept);
}
export function reduce(state: State, record: RecordValue): State {
	switch (record.type) {
		case "desk_api_summary": return { ...state, api: { ...state.api, summary: record.summary } };
		case "desk_api_open": return { ...state, api: { ...state.api, open: true, error: null, saved: false } };
		case "desk_api_close": return { ...state, api: { ...state.api, open: false, error: null } };
		case "desk_api_saving": return { ...state, api: { ...state.api, saving: true, error: null, saved: false } };
		case "desk_api_error": return { ...state, api: { ...state.api, saving: false, error: record.error, saved: false } };
		case "desk_api_saved": return { ...state, api: { ...state.api, saving: false, error: null, summary: record.summary, savedRevision: state.api.savedRevision + 1, saved: true } };
		case "desk_tick": {
			const confirms = state.confirms.filter((c) => c.deadline === null || c.deadline > record.now);
			return { ...state, now: record.now, confirms: confirms.length === state.confirms.length ? state.confirms : confirms };
		}
		case "desk_preferences": {
			const preferences = parsePreferences(record.preferences);
			return preferences ? { ...state, preferences } : state;
		}
		case "desk_system_theme": return { ...state, systemDark: record.dark === true };
		case "desk_focus_tasks": return { ...state, taskFocus: state.taskFocus + 1 };
		case "desk_confirm_closed": return { ...state, confirms: state.confirms.filter((c) => c.id !== record.id) };
		case "desk_error": return { ...state, error: text(record.error) };
		case "desk_stderr": return { ...state, diagnostics: (state.diagnostics + text(record.text)).slice(-8000) };
		case "desk_exit": return { ...state, connection: "exited", error: text(record.error), runActive: false, streaming: false, compacting: false, confirms: [], queued: [], pendingSplits: [] };
		case "desk_split_requested": return { ...state, pendingSplits: [...state.pendingSplits, record.id] };
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
			// The 2 s state poll usually reports nothing new; keep identity so L2 can skip publishing.
			if (state.connection === "ready" && state.model === model && state.imageInput === imageInput && state.thinking === thinking && state.streaming === streaming && state.compacting === compacting) return state;
			return { ...state, connection: "ready", model, imageInput, thinking, streaming, compacting };
		}
		case "agent_start": return { ...state, runActive: true, error: "" };
		// agent_end is intentionally not an idle transition: a nudge may start another run.
		case "agent_settled": return { ...state, runActive: false, streaming: false, compacting: false, queued: [], pendingSplits: [] };
		case "thinking_level_changed": return { ...state, thinking: text(record.level) };
		case "message_start": {
			const m = record.message;
			if (m?.role === "assistant") return addMessage(state, "assistant", contentBlocks(m.content));
			if (m?.role === "user") return addMessage(state, "user", contentBlocks(m.content), "", imageCount(m.content));
			if (m?.role === "custom" && m.customType === "tilldone-nudge") return addMessage(state, "nudge", contentBlocks(m.content));
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
			const tool: Tool = { id: record.toolCallId, name: record.toolName, args: record.args ?? null, result: null, phase: "running" };
			const active = record.toolName === TOOL.name ? undefined : current(state.list);
			const toolCalls = active ? { ...state.toolCalls, [active.id]: (state.toolCalls[active.id] ?? 0) + 1 } : state.toolCalls;
			return { ...state, toolCalls, tools: [...state.tools, tool], timeline: [...state.timeline, { kind: "tool", id: tool.id }] };
		}
		case "tool_execution_update":
			return { ...state, tools: state.tools.map((t) => t.id === record.toolCallId ? { ...t, result: record.partialResult } : t) };
		case "tool_execution_end": {
			const list = record.toolName === "tilldone" ? parseDetails(record.result?.details) ?? state.list : state.list;
			// A pending split is resolved once its task is gone from the list (split replaces it) or done.
			const pendingSplits = list === state.list ? state.pendingSplits : state.pendingSplits.filter((id) => list.tasks.some((t) => t.id === id && t.status !== "done"));
			return { ...state, list, pendingSplits, toolCalls: list === state.list ? state.toolCalls : keepCounts(state, list), tools: state.tools.map((t) => t.id === record.toolCallId
				? { ...t, result: record.result, phase: record.isError ? "error" : "done" } : t) };
		}
		case "extension_ui_request": {
			if (record.method === "setStatus") {
				const statuses = { ...state.statuses };
				if (typeof record.statusText === "string") statuses[record.statusKey] = record.statusText;
				else delete statuses[record.statusKey];
				return { ...state, statuses };
			}
			if (record.method === "confirm") return { ...state, confirms: [...state.confirms, {
				id: record.id, title: text(record.title), message: text(record.message),
				deadline: typeof record.timeout === "number" ? state.now + Math.max(0, record.timeout) : null,
			}] };
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
	| { type: "splitTask"; id: number }
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
	if (r.type === "confirm" && typeof r.id === "string" && typeof r.confirmed === "boolean") return { type: "confirm", id: r.id, confirmed: r.confirmed };
}
export function planIntent(state: State, intent: Intent): { commands: RecordValue[]; events: RecordValue[]; restart?: boolean; saveApi?: CredentialChanges; externalUrl?: string } {
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
	if (intent.type === "restart") return { ...empty, restart: state.connection === "exited" };
	// A new session is a fresh --no-session Pi process; mid-run, Stop first.
	if (intent.type === "newSession") return { ...empty, restart: state.connection === "ready" && !isRunning(state) };
	if (state.connection !== "ready") return empty;
	if (intent.type === "confirm") {
		if (!state.confirms.some((c) => c.id === intent.id && (c.deadline === null || c.deadline > state.now))) return empty;
		return { commands: [{ type: "extension_ui_response", id: intent.id, confirmed: intent.confirmed }], events: [{ type: "desk_confirm_closed", id: intent.id }] };
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
		const command: RecordValue = { type: isRunning(state) ? "steer" : "prompt", message: intent.message.trim() };
		if (images.length) command.images = images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
		return { commands: [command], events: [] };
	}
	return empty;
}
export function immediateUIResponse(record: RecordValue): RecordValue | undefined {
	if (record.type === "extension_ui_request" && ["select", "input", "editor"].includes(record.method)) {
		return { type: "extension_ui_response", id: record.id, cancelled: true };
	}
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
type Entry = { id: string; kind: string; label: string; text: string; images: number; error: string; args: string; result: string };
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
const isSilentAssistant = (m: Message) => m.kind === "assistant" && !m.error && Object.values(m.blocks).every((value) => !value.trim());
export function toViewModel(state: State) {
	const ui = copyFor(state.preferences.language);
	const counts = countByStatus(state.list);
	const active = current(state.list);
	const messages = new Map(state.messages.map((m) => [m.id, m]));
	const tools = new Map(state.tools.map((t) => [t.id, t]));
	return {
		ui,
		api: apiView(state.api, state.preferences.language, state.model),
		appearance: appearanceView(state.preferences, state.systemDark),
		connection: state.connection, error: state.error, diagnostics: state.diagnostics,
		status: { model: state.model, thinking: state.thinking, running: isRunning(state), cwd: state.cwd, tilldone: state.statuses.tilldone ?? "" },
		input: { enabled: state.connection === "ready", running: isRunning(state), newSession: state.connection === "ready" && !isRunning(state), images: state.connection === "ready" && state.imageInput },
		tasks: { title: state.list.title ?? "TillDone", description: state.list.description ?? "", done: counts.done,
			total: state.list.tasks.length, progress: `${counts.done} / ${state.list.tasks.length} ${ui.done}`,
			current: active ? `${ui.working} #${active.id}: ${active.text}` : ui.noActive, focus: state.taskFocus,
			items: state.list.tasks.map((t) => ({ ...t, label: t.from === undefined ? `#${t.id}` : `#${t.id} ← #${t.from}`, icon: STATUS_ICON[t.status], statusLabel: { idle: ui.taskIdle, inprogress: ui.taskInprogress, done: ui.taskDone }[t.status], current: t.id === active?.id,
				splittable: state.connection === "ready" && t.status !== "done", splitting: state.pendingSplits.includes(t.id),
				...toolCallsView(state.toolCalls[t.id] ?? 0, ui) })) },
		queued: state.queued,
		// A tool-only assistant turn carries no text, only the call the next tool card already shows.
		conversation: state.timeline.filter((entry) => entry.kind === "tool" || !isSilentAssistant(messages.get(entry.id)!)).map((entry) => {
			if (entry.kind === "tool") {
				const t = tools.get(entry.id)!;
				return entryFor(t, ui, () => ({ id: t.id, kind: "tool", label: `${t.name} · ${{ running: ui.toolRunning, done: ui.toolDone, error: ui.toolError }[t.phase]}`, text: "", images: 0, args: pretty(t.args), result: pretty(t.result), error: "" }));
			}
			const m = messages.get(entry.id)!;
			return entryFor(m, ui, () => ({ id: m.id, kind: m.kind, label: { assistant: ui.assistant, user: ui.user, nudge: ui.nudge, notice: ui.notice }[m.kind],
				text: Object.entries(m.blocks).sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value).join("\n"), images: m.images, error: m.error, args: "", result: "" }));
		}),
		confirm: state.confirms.length ? { ...state.confirms[0], remainingSeconds: state.confirms[0].deadline === null ? null : Math.max(0, Math.ceil((state.confirms[0].deadline - state.now) / 1000)) } : null,
	};
}
