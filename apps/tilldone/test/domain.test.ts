/** TillDone Desk L3 tests: recorded protocol projection, pure transitions, and intent rules. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initialState, reduce, toViewModel, planIntent, parseIntent, immediateUIResponse, viewChanged, collapseSkill } from "../src/domain.ts";
const records = readFileSync(new URL("fixtures/rpc-probe.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.dir === "out").map((r) => r.rec);
const initial = () => initialState("openai-codex/gpt-6.1-sol", "/work");

describe("recorded Pi run", () => {
	test("snapshots, current task, confirm, settlement, and live text", () => {
		let state = initial();
		let added = false, intermediate = false, confirmed = false, cleared = false, delta = "", settled = false;
		for (const r of records) {
			const before = JSON.stringify(state);
			const previous = state;
			state = reduce(state, r);
			expect(JSON.stringify(previous)).toBe(before);
			const vm = toViewModel(state);
			if (r.type === "tool_execution_end" && r.result.details.action === "add") {
				expect(vm.tasks.items.map((t) => [t.text, t.status])).toEqual([["alpha", "idle"], ["beta", "idle"]]);
				added = true;
			}
			if (state.list.tasks[0]?.status === "done" && state.list.tasks[1]?.status === "inprogress") {
				expect(vm.tasks.items.find((t) => t.current)?.text).toBe("beta");
				expect(vm.tasks.items[1].icon).toBe("●");
				intermediate = true;
			}
			if (r.type === "extension_ui_request" && r.method === "confirm") {
				expect(state.dialogs).toHaveLength(1);
				expect(vm.dialog?.id).toBe(r.id);
				confirmed = true;
			}
			if (r.type === "tool_execution_end" && r.result.details.action === "clear") {
				expect(state.list.tasks).toHaveLength(0);
				cleared = true;
			}
			if (r.assistantMessageEvent?.type === "text_delta") {
				delta += r.assistantMessageEvent.delta;
				expect(vm.conversation.at(-1)?.text).toBe(delta);
			}
			if (r.type === "agent_end") expect(vm.status.running).toBe(true);
			if (r.type === "agent_settled") { expect(vm.status.running).toBe(false); settled = true; }
		}
		expect([added, intermediate, confirmed, cleared, settled]).toEqual([true, true, true, true, true]);
		expect(delta).toBe("ok");
		expect(toViewModel(state).conversation.at(-1)?.text).toBe("ok");
		expect(JSON.parse(JSON.stringify(toViewModel(state)))).toEqual(toViewModel(state));
	});
});

test("text deltas concatenate by contentIndex; final message replaces partial text", () => {
	let s = reduce(initial(), { type: "message_start", message: { role: "assistant", content: [] } });
	for (const [contentIndex, delta] of [[2, "Hello "], [2, "world"], [4, "next"]] as const) {
		s = reduce(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta } });
	}
	expect(toViewModel(s).conversation[0].text).toBe("Hello world\nnext");
	s = reduce(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative" }] } });
	expect(toViewModel(s).conversation[0].text).toBe("authoritative");
});

test("only execution_end details change tasks; start args survive null end args", () => {
	const end = records.find((r) => r.type === "tool_execution_end" && r.result.details.action === "add");
	let s = reduce(initial(), { type: "message_end", message: { role: "toolResult", toolName: "tilldone", details: end.result.details } });
	expect(s.list.tasks).toHaveLength(0);
	s = reduce(s, { type: "tool_execution_start", toolCallId: end.toolCallId, toolName: "tilldone", args: { action: "add" } });
	s = reduce(s, { ...end, args: null });
	expect(s.list.tasks).toHaveLength(2);
	expect(s.tools[0].args).toEqual({ action: "add" });
	const old = s.list;
	s = reduce(s, { ...end, result: { details: { tasks: "invalid" } } });
	expect(s.list).toBe(old);
});

test("nudge is distinct, and get_state false cannot prematurely settle a run", () => {
	let s = reduce(initial(), { type: "agent_start" });
	s = reduce(s, { type: "agent_end" });
	s = reduce(s, { type: "response", command: "get_state", success: true, data: { isStreaming: false, thinkingLevel: "low" } });
	s = reduce(s, { type: "message_start", message: { role: "custom", customType: "tilldone-nudge", content: "Keep working" } });
	expect(toViewModel(s).conversation[0].kind).toBe("nudge");
	expect(toViewModel(s).status.running).toBe(true);
	expect(toViewModel(reduce(s, { type: "agent_settled" })).status.running).toBe(false);
});

test("dialog expiry is clock-driven and closes without responding", () => {
	let s = reduce(initial(), { type: "desk_tick", now: 100 });
	s = reduce(s, { type: "extension_ui_request", method: "confirm", id: "c", title: "Clear?", message: "All", timeout: 2000 });
	expect(toViewModel(s).dialog?.remainingSeconds).toBe(2);
	s = reduce(s, { type: "desk_tick", now: 2100 });
	expect(toViewModel(s).dialog).toBeNull();
	s = reduce(s, { type: "extension_ui_request", method: "input", id: "i", title: "Name", timeout: 1000 });
	expect(toViewModel(s).dialog?.remainingSeconds).toBe(1);
	expect(toViewModel(reduce(s, { type: "desk_tick", now: 3100 })).dialog).toBeNull();
});
describe("select, input and editor dialogs", () => {
	const ready = () => reduce(initialState("openai-codex/gpt-6.1-sol", "/w"), { type: "response", command: "get_state", success: true, data: { model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "low", isStreaming: false } });
	const ask = (state = ready()) => [
		{ type: "extension_ui_request", method: "select", id: "s", title: "Pick", options: ["a", "b"] },
		{ type: "extension_ui_request", method: "input", id: "i", title: "Name", placeholder: "hint" },
		{ type: "extension_ui_request", method: "editor", id: "e", title: "Notes", prefill: "x\ny" },
	].reduce(reduce, state);
	test("queue in arrival order and show one at a time with their own fields", () => {
		const s = ask();
		expect(s.dialogs.map((d) => d.kind)).toEqual(["select", "input", "editor"]);
		expect(toViewModel(s).dialog).toEqual({ id: "s", kind: "select", title: "Pick", message: "", options: ["a", "b"], placeholder: "", prefill: "", remainingSeconds: null });
		const closed = reduce(reduce(s, { type: "desk_dialog_closed", id: "s" }), { type: "desk_dialog_closed", id: "i" });
		expect(toViewModel(closed).dialog?.prefill).toBe("x\ny");
	});
	test("answers become value responses; null cancels", () => {
		const s = ask();
		expect(planIntent(s, { type: "answer", id: "s", value: "b" })).toEqual({ commands: [{ type: "extension_ui_response", id: "s", value: "b" }], events: [{ type: "desk_dialog_closed", id: "s" }] });
		expect(planIntent(s, { type: "answer", id: "i", value: "" }).commands).toEqual([{ type: "extension_ui_response", id: "i", value: "" }]);
		expect(planIntent(s, { type: "answer", id: "e", value: null }).commands).toEqual([{ type: "extension_ui_response", id: "e", cancelled: true }]);
	});
	test("rejects an option that was not offered, a wrong-kind reply, and stale ids", () => {
		const s = reduce(ask(), { type: "extension_ui_request", method: "confirm", id: "c", title: "t", message: "m" });
		expect(planIntent(s, { type: "answer", id: "s", value: "c" }).commands).toHaveLength(0);
		expect(planIntent(s, { type: "confirm", id: "s", confirmed: true }).commands).toHaveLength(0);
		expect(planIntent(s, { type: "answer", id: "c", value: "yes" }).commands).toHaveLength(0);
		expect(planIntent(s, { type: "answer", id: "gone", value: "a" }).commands).toHaveLength(0);
		expect(planIntent(reduce(s, { type: "desk_exit", error: "x" }), { type: "answer", id: "s", value: "a" }).commands).toHaveLength(0);
	});
	test("a select without usable options is cancelled at once and never shown", () => {
		for (const options of [undefined, [], [1, 2], Array.from({ length: 201 }, (_, i) => String(i))]) {
			const request = { type: "extension_ui_request", method: "select", id: "bad", title: "x", options };
			expect(immediateUIResponse(request)).toEqual({ type: "extension_ui_response", id: "bad", cancelled: true });
			expect(reduce(ready(), request).dialogs).toHaveLength(0);
		}
		for (const method of ["input", "editor", "confirm"]) expect(immediateUIResponse({ type: "extension_ui_request", method, id: "a" })).toBeUndefined();
	});
	test("parses answers: a bounded string or null", () => {
		expect(parseIntent({ type: "answer", id: "s", value: "a" })).toEqual({ type: "answer", id: "s", value: "a" });
		expect(parseIntent({ type: "answer", id: "s", value: null })).toEqual({ type: "answer", id: "s", value: null });
		for (const value of [undefined, 1, "x".repeat(100001)]) expect(parseIntent({ type: "answer", id: "s", value })).toBeUndefined();
	});
});

test("intent planning handles local /tilldone, steers every message sent while running, and rejects stale confirmations", () => {
	const s = reduce(initial(), { type: "response", command: "get_state", success: true, data: {} });
	expect(planIntent(s, { type: "submit", message: "/tilldone" }).commands).toHaveLength(0);
	expect(planIntent(s, { type: "submit", message: "Hi" }).commands[0].type).toBe("prompt");
	const running = reduce(s, { type: "agent_start" });
	expect(planIntent(running, { type: "submit", message: "Hi" }).commands[0].type).toBe("steer");
	expect(planIntent(s, { type: "confirm", id: "stale", confirmed: true }).commands).toHaveLength(0);
});
test("new session restarts Pi only while connected and idle", () => {
	const ready = reduce(initial(), { type: "response", command: "get_state", success: true, data: {} });
	expect(planIntent(ready, { type: "newSession" }).restart).toBe("fresh");
	expect(toViewModel(ready).input.newSession).toBe(true);
	const running = reduce(ready, { type: "agent_start" });
	expect(planIntent(running, { type: "newSession" }).restart).toBeFalsy();
	expect(toViewModel(running).input.newSession).toBe(false);
	expect(planIntent(initial(), { type: "newSession" }).restart).toBeFalsy();
	expect(planIntent(reduce(ready, { type: "desk_exit", error: "gone" }), { type: "newSession" }).restart).toBeFalsy();
});
test("Restart after an exit resumes the session file get_state reported", () => {
	const ready = reduce(initial(), { type: "response", command: "get_state", success: true, data: { sessionFile: "/s/a.jsonl" } });
	expect(ready.sessionFile).toBe("/s/a.jsonl");
	expect(planIntent(ready, { type: "restart" }).restart).toBeUndefined();
	const exited = reduce(ready, { type: "desk_exit", error: "gone" });
	expect(exited.sessionFile).toBe("/s/a.jsonl");
	expect(planIntent(exited, { type: "restart" }).restart).toBe("resume");
});
test("a missing session record leaves one notice in the user's language", () => {
	const s = reduce(initial(), { type: "desk_resume_unavailable" });
	expect(toViewModel(s).conversation.map((m) => [m.kind, m.text])).toEqual([["notice", "没有找到上次会话的记录，已开始新会话。"]]);
});
test("views stay put when only the clock or an unchanged state poll moves", () => {
	const polled = { type: "response", command: "get_state", success: true, data: { model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "low", isStreaming: false } };
	const ready = reduce(initial(), polled);
	expect(reduce(ready, polled)).toBe(ready);
	const ticked = reduce(ready, { type: "desk_tick", now: 1000 });
	expect(ticked.dialogs).toBe(ready.dialogs);
	expect(viewChanged(ready, ticked)).toBe(false);
	const asking = reduce(ticked, { type: "extension_ui_request", method: "confirm", id: "c", title: "t", message: "m", timeout: 5000 });
	expect(viewChanged(ticked, asking)).toBe(true);
	expect(viewChanged(asking, reduce(asking, { type: "desk_tick", now: 2000 }))).toBe(true);
});
test("streaming a token reuses view entries for the unchanged history", () => {
	let state = reduce(initial(), { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/a" } });
	state = reduce(state, { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
	state = reduce(state, { type: "message_start", message: { role: "assistant", content: [] } });
	const before = toViewModel(state).conversation;
	state = reduce(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } });
	const after = toViewModel(state).conversation;
	expect(after[0]).toBe(before[0]);
	expect(after[1]).not.toBe(before[1]);
	expect(after[1].text).toBe("hi");
});
test("assistant messages without text stay out of the conversation until text arrives", () => {
	const toolOnly = { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }] };
	let s = reduce(initial(), { type: "message_start", message: toolOnly });
	s = reduce(s, { type: "message_end", message: toolOnly });
	s = reduce(s, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	expect(toViewModel(s).conversation.map((e) => e.kind)).toEqual(["tool"]);
	s = reduce(s, { type: "message_start", message: { role: "assistant", content: [] } });
	expect(toViewModel(s).conversation.map((e) => e.kind)).toEqual(["tool"]);
	s = reduce(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
	expect(toViewModel(s).conversation.map((e) => [e.kind, e.text])).toEqual([["tool", ""], ["assistant", "done"]]);
});
test("an assistant message with an error but no text still shows", () => {
	const s = reduce(initial(), { type: "message_end", message: { role: "assistant", content: [], errorMessage: "rate limited" } });
	expect(toViewModel(s).conversation.map((e) => [e.kind, e.error])).toEqual([["assistant", "rate limited"]]);
});
test("split subtasks carry their origin into the task panel", () => {
	const details = { action: "split", nextId: 4, listTitle: "T", listDescription: undefined,
		tasks: [{ id: 2, text: "x", status: "inprogress", from: 1 }, { id: 3, text: "y", status: "idle", from: 1 }] };
	const s = reduce(initial(), { type: "tool_execution_end", toolCallId: "t", toolName: "tilldone", result: { details }, isError: false });
	expect(toViewModel(s).tasks.items.map((t) => t.label)).toEqual(["#2 ← #1", "#3 ← #1"]);
});
describe("split button", () => {
	const ready = () => reduce(reduce(initial(), { type: "response", command: "get_state", success: true, data: {} }), { type: "tool_execution_end", toolCallId: "t", toolName: "tilldone", isError: false,
		result: { details: { action: "add", nextId: 3, listTitle: "T", listDescription: undefined, tasks: [{ id: 1, text: "write docs", status: "idle" }, { id: 2, text: "old", status: "done" }] } } });
	test("parses only a positive integer task id", () => {
		expect(parseIntent({ type: "splitTask", id: 1 })).toEqual({ type: "splitTask", id: 1 });
		for (const id of [0, 1.5, "1", undefined]) expect(parseIntent({ type: "splitTask", id })).toBeUndefined();
	});
	test("asks Pi to split the task: a prompt when idle, a steer while running", () => {
		const message = "请把任务 #1「write docs」细分成更小的子任务：用 tilldone split（id=1）原位替换，然后继续。";
		expect(planIntent(ready(), { type: "splitTask", id: 1 }).commands).toEqual([{ type: "prompt", message }]);
		expect(planIntent(reduce(ready(), { type: "agent_start" }), { type: "splitTask", id: 1 }).commands).toEqual([{ type: "steer", message }]);
		const en = reduce(ready(), { type: "desk_preferences", preferences: { theme: "system", language: "en" } });
		expect(planIntent(en, { type: "splitTask", id: 1 }).commands[0].message).toBe("Split task #1 \"write docs\" into smaller subtasks with tilldone split (id=1), then continue.");
	});
	test("done, unknown, or disconnected tasks send nothing", () => {
		for (const id of [2, 9]) expect(planIntent(ready(), { type: "splitTask", id }).commands).toHaveLength(0);
		expect(planIntent(reduce(ready(), { type: "desk_exit", error: "gone" }), { type: "splitTask", id: 1 }).commands).toHaveLength(0);
	});
	test("the panel offers the button on unfinished tasks while Pi is connected", () => {
		expect(toViewModel(ready()).tasks.items.map((t) => t.splittable)).toEqual([true, false]);
		expect(toViewModel(reduce(ready(), { type: "desk_exit", error: "gone" })).tasks.items.map((t) => t.splittable)).toEqual([false, false]);
		expect(toViewModel(ready()).ui.split).toBe("细分");
	});
});
describe("pasted images", () => {
	const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
	const withModel = (input: string[]) => reduce(initial(), { type: "response", command: "get_state", success: true, data: { model: { provider: "p", id: "m", input } } });
	test("parseIntent accepts up to 10 well-formed images and rejects the rest", () => {
		expect(parseIntent({ type: "submit", message: "hi", images: [png] })).toEqual({ type: "submit", message: "hi", images: [png] });
		expect(parseIntent({ type: "submit", message: "hi" })).toEqual({ type: "submit", message: "hi", images: [] });
		for (const images of [[{ ...png, mimeType: "image/svg+xml" }], [{ ...png, data: "not base64!" }], [{ ...png, data: 5 }], Array(11).fill(png), "x"]) {
			expect(parseIntent({ type: "submit", message: "hi", images })).toBeUndefined();
		}
	});
	test("images ride along on prompt and steer; an image alone is enough", () => {
		const ready = withModel(["text", "image"]);
		const wire = [{ type: "image", data: png.data, mimeType: png.mimeType }];
		expect(planIntent(ready, { type: "submit", message: "  ", images: [png] }).commands).toEqual([{ type: "prompt", message: "", images: wire }]);
		const running = reduce(ready, { type: "agent_start" });
		expect(planIntent(running, { type: "submit", message: "look", images: [png] }).commands).toEqual([{ type: "steer", message: "look", images: wire }]);
		expect(planIntent(ready, { type: "submit", message: "text", images: [] }).commands).toEqual([{ type: "prompt", message: "text" }]);
	});
	test("a text-only model gets no images, and the view says so", () => {
		const textOnly = withModel(["text"]);
		expect(planIntent(textOnly, { type: "submit", message: "look", images: [png] }).commands).toHaveLength(0);
		expect(toViewModel(textOnly).input.images).toBe(false);
		expect(toViewModel(withModel(["text", "image"])).input.images).toBe(true);
	});
	test("a model switch reported by the state poll updates image support", () => {
		const ready = withModel(["text", "image"]);
		expect(toViewModel(reduce(ready, { type: "response", command: "get_state", success: true, data: { model: { provider: "p", id: "m", input: ["text"] } } })).input.images).toBe(false);
	});
	test("conversation entries count the images a message carries", () => {
		const s = reduce(initial(), { type: "message_start", message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "image", data: "y", mimeType: "image/png" }] } });
		expect(toViewModel(s).conversation.map((e) => [e.text, e.images])).toEqual([["see", 2]]);
	});
});
describe("messages waiting for delivery", () => {
	const running = () => reduce(reduce(initial(), { type: "response", command: "get_state", success: true, data: {} }), { type: "agent_start" });
	test("the view lists Pi's pending steering and follow-up queue", () => {
		const s = reduce(running(), { type: "queue_update", steering: ["redirect"], followUp: ["later"] });
		expect(toViewModel(s).queued).toEqual(["redirect", "later"]);
		expect(toViewModel(reduce(s, { type: "queue_update", steering: [], followUp: [] })).queued).toEqual([]);
	});
	test("a settled run or a dead Pi leaves nothing pending", () => {
		const s = reduce(running(), { type: "queue_update", steering: ["redirect"], followUp: [] });
		expect(toViewModel(reduce(s, { type: "agent_settled" })).queued).toEqual([]);
		expect(toViewModel(reduce(s, { type: "desk_exit", error: "" })).queued).toEqual([]);
	});
	test("malformed queue updates are ignored", () => {
		const s = reduce(running(), { type: "queue_update", steering: ["a"], followUp: [] });
		expect(reduce(s, { type: "queue_update", steering: "a", followUp: [] })).toBe(s);
	});
});
describe("split requests", () => {
	const details = (tasks: object[]) => ({ type: "tool_execution_end", toolCallId: "t", toolName: "tilldone", isError: false, result: { details: { action: "add", nextId: 9, listTitle: "T", listDescription: undefined, tasks } } });
	const ready = () => reduce(reduce(reduce(initial(), { type: "response", command: "get_state", success: true, data: {} }), { type: "agent_start" }),
		details([{ id: 1, text: "big", status: "inprogress" }, { id: 2, text: "next", status: "idle" }]));
	const request = (s: ReturnType<typeof ready>, id: number) => {
		const plan = planIntent(s, { type: "splitTask", id });
		return { plan, state: plan.events.reduce(reduce, s) };
	};
	test("a second click on the same task sends nothing while the first is pending", () => {
		const first = request(ready(), 1);
		expect(first.plan.commands).toHaveLength(1);
		expect(request(first.state, 1).plan.commands).toHaveLength(0);
		expect(request(first.state, 2).plan.commands).toHaveLength(1);
	});
	test("the pending task shows as splitting until the split replaces it", () => {
		const { state } = request(ready(), 1);
		expect(toViewModel(state).tasks.items.map((t) => [t.id, t.splitting])).toEqual([[1, true], [2, false]]);
		const split = reduce(state, details([{ id: 3, text: "a", status: "inprogress", from: 1 }, { id: 4, text: "b", status: "idle", from: 1 }, { id: 2, text: "next", status: "idle" }]));
		expect(toViewModel(split).tasks.items.some((t) => t.splitting)).toBe(false);
		expect(split.pendingSplits).toEqual([]);
	});
	test("a run that ends without splitting releases the button", () => {
		const { state } = request(ready(), 1);
		expect(reduce(state, { type: "agent_settled" }).pendingSplits).toEqual([]);
	});
});
describe("tool calls per task", () => {
	const list = (nextId: number, tasks: object[]) => ({ type: "tool_execution_end", toolCallId: `l${nextId}`, toolName: "tilldone", isError: false,
		result: { details: { action: "add", nextId, listTitle: "T", listDescription: undefined, tasks } } });
	const tool = (name: string, id = name) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
	const working = (active: number) => reduce(initial(), list(3, [{ id: 1, text: "a", status: active === 1 ? "inprogress" : "idle" }, { id: 2, text: "b", status: active === 2 ? "inprogress" : "idle" }]));
	const counts = (s: ReturnType<typeof initial>) => toViewModel(s).tasks.items.map((t) => [t.id, t.toolCalls]);
	test("tools started while a task is in progress count against that task", () => {
		const s = [tool("bash", "x"), tool("read", "y"), tool("tilldone", "z")].reduce(reduce, working(1));
		expect(counts(s)).toEqual([[1, 2], [2, 0]]);
	});
	test("nothing is counted while no task is in progress", () => {
		expect(counts(reduce(working(0), tool("read")))).toEqual([[1, 0], [2, 0]]);
	});
	test("each task keeps its own count across switches", () => {
		let s = reduce(working(1), tool("bash", "x"));
		s = reduce(s, list(3, [{ id: 1, text: "a", status: "idle" }, { id: 2, text: "b", status: "inprogress" }]));
		s = reduce(s, tool("edit", "y"));
		s = reduce(s, list(3, [{ id: 1, text: "a", status: "inprogress" }, { id: 2, text: "b", status: "idle" }]));
		s = reduce(s, tool("bash", "z"));
		expect(counts(s)).toEqual([[1, 2], [2, 1]]);
	});
	test("a new list starts from zero even when it reuses task ids", () => {
		const s = reduce(reduce(working(1), tool("bash")), list(2, [{ id: 1, text: "fresh", status: "idle" }]));
		expect(counts(s)).toEqual([[1, 0]]);
	});
	test("a task that is split away drops its count; its subtasks start at zero", () => {
		const s = reduce(reduce(working(1), tool("bash")), list(5, [{ id: 3, text: "a1", status: "inprogress", from: 1 }, { id: 4, text: "a2", status: "idle", from: 1 }, { id: 2, text: "b", status: "idle" }]));
		expect(s.toolCalls).toEqual({});
		expect(counts(s)).toEqual([[3, 0], [4, 0], [2, 0]]);
	});
	test("the view labels the count and flags a task once it reaches the split hint threshold", () => {
		const items = (s: ReturnType<typeof initial>) => toViewModel(s).tasks.items.map((t) => [t.toolCallsLabel, t.heavy]);
		expect(items(working(1))[0]).toEqual(["", false]);
		expect(items(reduce(working(1), tool("bash")))[0]).toEqual(["1 工具", false]);
		const heavy = Array.from({ length: 15 }, (_, i) => tool("bash", `b${i}`)).reduce(reduce, working(1));
		expect(items(heavy)[0]).toEqual(["15 工具", true]);
		const en = reduce(heavy, { type: "desk_preferences", preferences: { theme: "system", language: "en" } });
		expect(toViewModel(en).tasks.items[0].toolCallsLabel).toBe("15 tools");
		const enOne = reduce(reduce(working(1), tool("bash")), { type: "desk_preferences", preferences: { theme: "system", language: "en" } });
		expect(toViewModel(enOne).tasks.items[0].toolCallsLabel).toBe("1 tool");
		expect(toViewModel(heavy).tasks.items[0].toolCallsTitle).toBe("这个任务进行期间边牧调用其他工具的次数（不含管理清单的 tilldone 调用）；每满 15 次会提醒边牧考虑细分");
	});
});
describe("model calls per task", () => {
	const list = (nextId: number, tasks: object[]) => ({ type: "tool_execution_end", toolCallId: `l${nextId}`, toolName: "tilldone", isError: false,
		result: { details: { action: "add", nextId, listTitle: "T", listDescription: undefined, tasks } } });
	const turn = { type: "turn_start" };
	const active = (id: number) => list(3, [{ id: 1, text: "a", status: id === 1 ? "inprogress" : "idle" }, { id: 2, text: "b", status: id === 2 ? "inprogress" : "idle" }]);
	const counts = (s: ReturnType<typeof initial>) => toViewModel(s).tasks.items.map((t) => [t.id, t.modelCalls]);
	test("each turn started while a task is in progress counts against it", () => {
		const s = [active(1), turn, turn, active(2), turn].reduce(reduce, initial());
		expect(counts(s)).toEqual([[1, 2], [2, 1]]);
	});
	test("the turn that starts the first task is not counted against it", () => {
		const s = [list(3, [{ id: 1, text: "a", status: "idle" }, { id: 2, text: "b", status: "idle" }]), turn, active(1)].reduce(reduce, initial());
		expect(counts(s)).toEqual([[1, 0], [2, 0]]);
	});
	test("a new list starts from zero and split subtasks start at zero", () => {
		expect(counts([active(1), turn, list(2, [{ id: 1, text: "fresh", status: "idle" }])].reduce(reduce, initial()))).toEqual([[1, 0]]);
		const split = [active(1), turn, list(5, [{ id: 3, text: "a1", status: "inprogress", from: 1 }, { id: 4, text: "a2", status: "idle", from: 1 }, { id: 2, text: "b", status: "idle" }])].reduce(reduce, initial());
		expect(counts(split)).toEqual([[3, 0], [4, 0], [2, 0]]);
	});
	test("the view labels model calls in both languages", () => {
		const one = [active(1), turn].reduce(reduce, initial());
		const three = [turn, turn].reduce(reduce, one);
		expect(toViewModel(one).tasks.items[0].modelCallsLabel).toBe("1 模型");
		expect(toViewModel(three).tasks.items[0].modelCallsLabel).toBe("3 模型");
		expect(toViewModel(reduce(initial(), active(1))).tasks.items[0].modelCallsLabel).toBe("");
		const en = (s: ReturnType<typeof initial>) => reduce(s, { type: "desk_preferences", preferences: { theme: "system", language: "en" } });
		expect(toViewModel(en(one)).tasks.items[0].modelCallsLabel).toBe("1 llm");
		expect(toViewModel(en(three)).tasks.items[0].modelCallsLabel).toBe("3 llms");
		expect(toViewModel(one).tasks.items[0].modelCallsTitle).toContain("大模型");
	});
});
describe("copying an assistant reply", () => {
	const reply = () => [
		{ type: "message_start", message: { role: "user", content: "hi" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Title" }, { type: "toolCall", id: "c" }, { type: "text", text: "- **a**\n- b" }] } },
	].reduce(reduce, initial());
	const idOf = (s: ReturnType<typeof initial>, kind: string) => toViewModel(s).conversation.find((e) => e.kind === kind)!.id;
	test("parses only a message id", () => {
		expect(parseIntent({ type: "copyMessage", id: "message-2" })).toEqual({ type: "copyMessage", id: "message-2" });
		for (const id of [2, "", undefined, "x".repeat(65)]) expect(parseIntent({ type: "copyMessage", id })).toBeUndefined();
	});
	test("copies the reply's Markdown source, not rendered text", () => {
		const s = reply();
		expect(planIntent(s, { type: "copyMessage", id: idOf(s, "assistant") })).toEqual({ commands: [], events: [], clipboard: "## Title\n- **a**\n- b" });
	});
	test("works while Pi is busy or gone; it touches no RPC", () => {
		const s = reduce(reduce(reply(), { type: "agent_start" }), { type: "desk_exit", error: "gone" });
		expect(planIntent(s, { type: "copyMessage", id: idOf(s, "assistant") }).clipboard).toBe("## Title\n- **a**\n- b");
	});
	test("only assistant replies with text can be copied", () => {
		const s = reply();
		expect(planIntent(s, { type: "copyMessage", id: idOf(s, "user") }).clipboard).toBeUndefined();
		expect(planIntent(s, { type: "copyMessage", id: "message-99" }).clipboard).toBeUndefined();
		const silent = reduce(initial(), { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "  " }], errorMessage: "boom" } });
		expect(planIntent(silent, { type: "copyMessage", id: idOf(silent, "assistant") }).clipboard).toBeUndefined();
	});
	test("the view marks which entries offer a copy button, with localized labels", () => {
		const s = reply();
		const view = toViewModel(s);
		expect(view.conversation.map((e) => [e.kind, e.copyable])).toEqual([["user", false], ["assistant", true]]);
		expect([view.ui.copy, view.ui.copied]).toEqual(["复制 Markdown", "已复制"]);
	});
});
describe("opening a link in a reply", () => {
	const source = "见 [MU历史行情](https://finance.example.com/MU?range=1w&x=行情)、www.example.org 和 [脚本](javascript:alert(1))、[凭据](https://user:pw@evil.example.com/)、[相对](/docs)";
	const reply = () => [
		{ type: "message_start", message: { role: "user", content: "看 https://user.example.com/" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: source }] } },
	].reduce(reduce, initial());
	const idOf = (s: ReturnType<typeof initial>, kind: string) => toViewModel(s).conversation.find((e) => e.kind === kind)!.id;
	const open = (s: ReturnType<typeof initial>, id: string, url: string) => planIntent(s, { type: "openLink", id, url });
	test("parses a message id and a bounded URL string", () => {
		expect(parseIntent({ type: "openLink", id: "message-2", url: "https://a.example/" })).toEqual({ type: "openLink", id: "message-2", url: "https://a.example/" });
		for (const bad of [{ id: 2, url: "https://a.example/" }, { id: "m", url: 5 }, { id: "m", url: "" }, { id: "m", url: `https://a.example/${"x".repeat(2048)}` }]) {
			expect(parseIntent({ type: "openLink", ...bad })).toBeUndefined();
		}
	});
	test("opens an http(s) link that the reply really contains, in the system browser", () => {
		const s = reply(), id = idOf(s, "assistant");
		expect(open(s, id, "https://finance.example.com/MU?range=1w&x=行情")).toEqual({ commands: [], events: [], externalUrl: "https://finance.example.com/MU?range=1w&x=行情" });
		expect(open(s, id, "http://www.example.org").externalUrl).toBe("http://www.example.org");
	});
	test("works while Pi is busy or gone; it sends no RPC", () => {
		const s = reduce(reduce(reply(), { type: "agent_start" }), { type: "desk_exit", error: "gone" });
		expect(open(s, idOf(s, "assistant"), "http://www.example.org").externalUrl).toBe("http://www.example.org");
	});
	test("a URL the reply does not contain is not opened", () => {
		const s = reply();
		expect(open(s, idOf(s, "assistant"), "https://other.example.com/").externalUrl).toBeUndefined();
		expect(open(s, idOf(s, "user"), "https://user.example.com/").externalUrl).toBeUndefined();
		expect(open(s, "message-99", "http://www.example.org").externalUrl).toBeUndefined();
	});
	test("links in the reply that are not plain http(s) addresses are not opened", () => {
		const s = reply(), id = idOf(s, "assistant");
		for (const url of ["javascript:alert(1)", "https://user:pw@evil.example.com/", "/docs"]) expect(open(s, id, url).externalUrl).toBeUndefined();
	});
});
describe("pstack Poteto Mode", () => {
	const ready = (pstack = true) => reduce(initialState("openai-codex/gpt-6.1-sol", "/w", undefined, false, pstack), { type: "response", command: "get_state", success: true, data: { model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "low", isStreaming: false } });
	const apply = (state: ReturnType<typeof ready>, plan: { events: any[] }) => plan.events.reduce(reduce, state);
	test("without pstack nothing is prefixed and no badge shows", () => {
		const s = ready(false);
		expect(toViewModel(s).poteto).toEqual({ available: false, active: false });
		expect(planIntent(s, { type: "submit", message: "分析 GOOG" })).toEqual({ commands: [{ type: "prompt", message: "分析 GOOG" }], events: [] });
	});
	test("with pstack only the session's first idle prompt carries the skill prefix", () => {
		let s = ready();
		expect(toViewModel(s).poteto).toEqual({ available: true, active: false });
		const first = planIntent(s, { type: "submit", message: " 分析 GOOG " });
		expect(first.commands).toEqual([{ type: "prompt", message: "/skill:poteto-mode 分析 GOOG" }]);
		s = apply(s, first);
		expect(toViewModel(s).poteto.active).toBe(true);
		expect(planIntent(s, { type: "submit", message: "继续" }).commands).toEqual([{ type: "prompt", message: "继续" }]);
	});
	test("steers and other slash commands pass unchanged and leave it pending", () => {
		const s = ready();
		expect(planIntent(reduce(s, { type: "agent_start" }), { type: "submit", message: "redirect" })).toEqual({ commands: [{ type: "steer", message: "redirect" }], events: [] });
		expect(planIntent(s, { type: "submit", message: "/setup-pstack" })).toEqual({ commands: [{ type: "prompt", message: "/setup-pstack" }], events: [] });
	});
	test("a hand-typed /skill:poteto-mode is sent as is and counts as switching on", () => {
		const plan = planIntent(ready(), { type: "submit", message: "/skill:poteto-mode go" });
		expect(plan.commands).toEqual([{ type: "prompt", message: "/skill:poteto-mode go" }]);
		expect(apply(ready(), plan).poteto.on).toBe(true);
	});
	test("an expanded skill shows as the command the user typed", () => {
		const skill = '<skill name="poteto-mode" location="/x/SKILL.md">\nReferences...\n# Poteto\n</skill>\n\n分析 GOOG';
		const s = reduce(ready(), { type: "message_start", message: { role: "user", content: [{ type: "text", text: skill }] } });
		expect(toViewModel(s).conversation.at(-1)?.text).toBe("/skill:poteto-mode 分析 GOOG");
		expect(collapseSkill('<skill name="a" location="b">x</skill>')).toBe("/skill:a");
		expect(collapseSkill("plain <skill> text")).toBe("plain <skill> text");
	});
});

describe("activity bar", () => {
	const at = (state: ReturnType<typeof initial>, now: number, record?: Record<string, unknown>) => {
		const ticked = reduce(state, { type: "desk_tick", now });
		return record ? reduce(ticked, record) : ticked;
	};
	const bar = (state: ReturnType<typeof initial>) => toViewModel(state).activity;
	const started = () => at(initial(), 1000, { type: "agent_start" });
	const usage = (u: Record<string, number> = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...u });
	const pending = { agent: "reviewer", source: "pending", task: "review", exitCode: -1, messages: [], stderr: "", usage: usage() };
	const working = { agent: "poteto-agent", source: "bundled", task: "dig", model: "openai-codex/gpt-x", exitCode: 0, stderr: "",
		usage: usage({ input: 30000, output: 1000, cacheRead: 10000, turns: 7 }),
		messages: [
			{ role: "user", content: "dig", timestamp: 10_000 },
			{ role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "toolCall", name: "bash", arguments: { command: "rg  activity\nsrc" } }], stopReason: "toolUse", timestamp: 20_000, durationMs: 5_000 },
		] };
	const finished = { agent: "explorer", source: "bundled", task: "find", exitCode: 0, stderr: "", usage: usage(),
		messages: [{ role: "assistant", content: [{ type: "text", text: "Found it." }], stopReason: "stop", timestamp: 12_000, durationMs: 3_000 }] };
	const delegating = (state: ReturnType<typeof initial>, now: number, results: unknown) =>
		at(state, now, { type: "tool_execution_update", toolCallId: "sub", toolName: "subagent", partialResult: { content: [], details: { results } } });
	const subagents = () => at(started(), 5000, { type: "tool_execution_start", toolCallId: "sub", toolName: "subagent", args: { tasks: [] } });

	test("idle shows no bar", () => {
		expect(bar(initial())).toBeNull();
		expect(bar(at(started(), 2000, { type: "agent_settled" }))).toBeNull();
	});
	test("between tools the model is thinking, timed from the turn", () => {
		const s = at(started(), 13_000);
		expect(bar(s)).toMatchObject({ text: "模型思考中", elapsed: "12 秒", total: "本次运行 12 秒", lastActivity: "最后动静：12 秒前", stale: false, children: [] });
	});
	test("a running bash tool shows its command; its end starts a new thinking spell", () => {
		let s = at(started(), 2000, { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "uv run pytest -q" } });
		expect(bar(at(s, 42_000))).toMatchObject({ text: "执行 bash：uv run pytest -q", elapsed: "40 秒" });
		s = at(s, 42_000, { type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false });
		expect(bar(at(s, 45_000))).toMatchObject({ text: "模型思考中", elapsed: "3 秒", total: "本次运行 44 秒" });
	});
	test("a tool an aborted run never finished does not show in the next run", () => {
		let s = at(started(), 2000, { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "sleep 99" } });
		s = at(s, 3000, { type: "agent_settled" });
		s = at(s, 4000, { type: "agent_start" });
		expect(bar(at(s, 5000))?.text).toBe("模型思考中");
	});
	test("compaction reported by the state poll shows as compacting", () => {
		const s = at(started(), 2000, { type: "response", command: "get_state", success: true, data: { isCompacting: true } });
		expect(bar(s)?.text).toBe("压缩上下文中");
	});
	test("a subagent call lists each child with status, progress and latest step", () => {
		const s = at(delegating(subagents(), 30_000, [pending, working, finished]), 30_000);
		const view = bar(s)!;
		expect(view).toMatchObject({ text: "等待 3 个子 agent（1 个完成）", elapsed: "25 秒", total: "本次运行 29 秒" });
		expect(view.children.map((c) => [c.status, c.icon])).toEqual([["pending", "○"], ["running", "◐"], ["done", "✓"]]);
		expect(view.children.map((c) => c.text)).toEqual([
			"reviewer · 排队中",
			"poteto-agent · openai-codex/gpt-x · 运行 20 秒 · 7 轮 · 41k tokens · bash: rg activity src",
			"explorer · 完成 · 用时 3 秒 · 1 轮 · Found it.",
		]);
		expect(view.children.every((c) => c.nested === "" && !c.stale)).toBe(true);
	});
	test("a child waiting on its own subagent call shows the delegation until the result returns", () => {
		const call = { role: "assistant", content: [{ type: "toolCall", name: "subagent", arguments: { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] } }], stopReason: "toolUse", timestamp: 20_000, durationMs: 1000 };
		const nesting = { ...working, messages: [working.messages[0], call] };
		let s = delegating(subagents(), 30_000, [nesting]);
		expect(bar(s)).toMatchObject({ text: "等待 1 个子 agent", children: [{ status: "running", nested: "转包 2 个子 agent" }] });
		s = delegating(s, 31_000, [{ ...nesting, messages: [...nesting.messages, { role: "toolResult", toolName: "subagent", content: [], timestamp: 31_000 }] }]);
		expect(bar(s)!.children[0]).toMatchObject({ status: "running", nested: "", text: expect.stringContaining("· subagent") });
	});
	test("failed children count separately, in English too", () => {
		const failed = { ...working, agent: "broken", exitCode: 1, stopReason: "error" };
		const s = delegating(reduce(subagents(), { type: "desk_preferences", preferences: { theme: "system", language: "en" } }), 30_000, [pending, failed, finished]);
		const view = bar(s)!;
		expect(view.text).toBe("Waiting on 3 subagents (1 done, 1 failed)");
		expect(view.children.map((c) => c.status)).toEqual(["pending", "failed", "done"]);
		expect(view.children[0].text).toBe("reviewer · queued");
	});
	test("the run turns stale after 60 s without Pi activity, a child after 120 s", () => {
		expect(bar(at(started(), 60_999))?.stale).toBe(false);
		expect(bar(at(started(), 61_000))?.stale).toBe(true);
		const s = delegating(subagents(), 30_000, [working]);
		expect(bar(at(s, 25_000 + 119_999))!.children[0].stale).toBe(false);
		expect(bar(at(s, 25_000 + 120_000))!.children[0].stale).toBe(true);
	});
	test("malformed subagent details never throw and skip unusable entries", () => {
		for (const partialResult of [null, "x", { details: "x" }, { details: { results: "x" } }]) {
			const s = at(subagents(), 6000, { type: "tool_execution_update", toolCallId: "sub", toolName: "subagent", partialResult });
			expect(bar(s)).toMatchObject({ text: "等待 0 个子 agent", children: [] });
		}
		const s = delegating(subagents(), 6000, [null, 5, { agent: 3 }, { agent: "odd", messages: "nope", usage: "x", exitCode: "bad", model: 7 }]);
		expect(bar(s)!.children.map((c) => [c.agent, c.status, c.text])).toEqual([["odd", "running", "odd · 运行 1 秒"]]);
	});
	test("while running, a new displayed second is a view change; while idle the clock is not", () => {
		const s = started();
		expect(viewChanged(s, at(s, 1900))).toBe(false);
		expect(viewChanged(s, at(s, 2000))).toBe(true);
		const idle = at(s, 3000, { type: "agent_settled" });
		expect(viewChanged(idle, at(idle, 9000))).toBe(false);
	});
});
