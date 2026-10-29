/** TillDone Desk L3 tests: recorded protocol projection, pure transitions, and intent rules. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initialState, reduce, toViewModel, planIntent, immediateUIResponse } from "../src/domain.ts";
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
				expect(state.confirms).toHaveLength(1);
				expect(vm.confirm?.id).toBe(r.id);
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

test("confirm expiry is clock-driven, closes without responding; unsupported dialogs cancel", () => {
	let s = reduce(initial(), { type: "desk_tick", now: 100 });
	s = reduce(s, { type: "extension_ui_request", method: "confirm", id: "c", title: "Clear?", message: "All", timeout: 2000 });
	expect(toViewModel(s).confirm?.remainingSeconds).toBe(2);
	s = reduce(s, { type: "desk_tick", now: 2100 });
	expect(toViewModel(s).confirm).toBeNull();
	for (const method of ["select", "input", "editor"]) expect(immediateUIResponse({ type: "extension_ui_request", method, id: "a" })).toEqual({ type: "extension_ui_response", id: "a", cancelled: true });
});

test("intent planning handles local /tilldone, steer, follow-up and rejects stale confirmations", () => {
	const s = reduce(initial(), { type: "response", command: "get_state", success: true, data: {} });
	expect(planIntent(s, { type: "submit", message: "/tilldone", mode: "steer" }).commands).toHaveLength(0);
	expect(planIntent(s, { type: "submit", message: "Hi", mode: "steer" }).commands[0].type).toBe("prompt");
	const running = reduce(s, { type: "agent_start" });
	expect(planIntent(running, { type: "submit", message: "Hi", mode: "steer" }).commands[0].type).toBe("steer");
	expect(planIntent(running, { type: "submit", message: "Hi", mode: "followUp" }).commands[0].type).toBe("follow_up");
	expect(planIntent(s, { type: "confirm", id: "stale", confirmed: true }).commands).toHaveLength(0);
});
