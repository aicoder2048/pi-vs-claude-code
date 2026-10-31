// Expected values are transcribed from extensions/tilldone.ts (line refs as T:n), never from a run of state.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type Ask,
	agentEnd,
	type Details,
	gate,
	INITIAL_MODEL,
	type Model,
	type Params,
	parseDetails,
	type Reply,
	restore,
	runTool,
	userInput,
} from "./state.ts";

function reply(r: Ask | Reply): Reply {
	expect(r.kind).toBe("reply");
	return r as Reply;
}

function ask(r: Ask | Reply): Ask {
	expect(r.kind).toBe("ask");
	return r as Ask;
}

/** Runs params that must succeed without a dialog and returns the next model. */
function step(m: Model, params: Params): Model {
	const r = reply(runTool(m, params));
	expect(r.next).toBeDefined();
	return r.next!;
}

const run = (m: Model, ...steps: Params[]) => steps.reduce(step, m);
const withTasks = (...texts: string[]) => step(INITIAL_MODEL, { action: "add", texts });
const statuses = (m: Model) => m.list.tasks.map((t) => `${t.id}:${t.status}`);

describe("new-list (T:405-442)", () => {
	test("missing text is an error that leaves the model alone", () => {
		const r = reply(runTool(INITIAL_MODEL, { action: "new-list" }));
		expect(r.text).toBe("Error: text (title) required for new-list");
		expect(r.details.error).toBe("text required");
		expect(r.next).toBeUndefined();
	});

	test("on an empty untitled list it succeeds without asking", () => {
		const r = reply(runTool(INITIAL_MODEL, { action: "new-list", text: "T", description: "D" }));
		expect(r.text).toBe('New list: "T" — D');
		expect(r.details).toEqual({ action: "new-list", tasks: [], nextId: 1, listTitle: "T", listDescription: "D" });
	});

	test("an empty description is dropped", () => {
		const r = reply(runTool(INITIAL_MODEL, { action: "new-list", text: "T", description: "" }));
		expect(r.text).toBe('New list: "T"');
		expect(r.next!.list.description).toBeUndefined();
	});

	test("asks while a task is not done", () => {
		const m = run(INITIAL_MODEL, { action: "new-list", text: "T" }, { action: "add", texts: ["a", "b"] }, { action: "toggle", id: 1 }, { action: "toggle", id: 1 });
		const a = ask(runTool(m, { action: "new-list", text: "U" }));
		expect([a.title, a.message, a.timeoutMs]).toEqual(["Start a new list?", 'This will replace "T" (2 task(s), 1 not done). Continue?', 30000]);
		expect(ask(runTool(withTasks("a"), { action: "new-list", text: "U" })).message).toBe("This will replace the current list (1 task(s), 1 not done). Continue?");
	});

	test("replaces a titled-but-empty or all-done list without asking", () => {
		const titled = step(INITIAL_MODEL, { action: "new-list", text: "T" });
		const done = run(withTasks("a"), { action: "toggle", id: 1 }, { action: "toggle", id: 1 });
		for (const m of [titled, done]) expect(reply(runTool(m, { action: "new-list", text: "U" })).next!.list.title).toBe("U");
	});

	test("denied consent cancels and keeps the list in details", () => {
		const m = withTasks("a");
		const r = runTool(m, { action: "new-list", text: "U" }, false);
		expect(r.text).toBe("New list cancelled by user.");
		expect(r.details.error).toBe("cancelled");
		expect(r.details.tasks).toEqual([{ id: 1, text: "a", status: "idle" }]);
		expect(r.next).toBeUndefined();
	});

	test("granted consent resets tasks and ids", () => {
		const r = runTool(withTasks("a", "b"), { action: "new-list", text: "U" }, true);
		expect(r.next!.list).toEqual({ tasks: [], nextId: 1, title: "U", description: undefined });
	});
});

describe("list (T:444-458)", () => {
	test("empty list text, and it still repaints", () => {
		const r = reply(runTool(INITIAL_MODEL, { action: "list" }));
		expect(r.text).toBe("No tasks defined yet.");
		expect(r.next).toBe(INITIAL_MODEL);
	});

	test("titled list lines", () => {
		const m = run(INITIAL_MODEL, { action: "new-list", text: "T" }, { action: "add", texts: ["a", "b"] }, { action: "toggle", id: 2 });
		expect(reply(runTool(m, { action: "list" })).text).toBe("T:\n[○] #1 (idle): a\n[●] #2 (inprogress): b");
	});

	test("untitled list has no header", () => {
		expect(reply(runTool(withTasks("a"), { action: "list" })).text).toBe("[○] #1 (idle): a");
	});
});

describe("add (T:460-483)", () => {
	test.each([[{ action: "add" }], [{ action: "add", texts: [] }], [{ action: "add", text: "" }]] as [Params][])("%j is an error", (params) => {
		const r = reply(runTool(INITIAL_MODEL, params));
		expect([r.text, r.details.error, r.next]).toEqual(["Error: text or texts required for add", "text required", undefined]);
	});

	test("texts wins over text", () => {
		const r = reply(runTool(INITIAL_MODEL, { action: "add", text: "x", texts: ["a", "b"] }));
		expect(r.text).toBe("Added 2 tasks: #1, #2");
		expect(r.next!.list.tasks.map((t) => t.text)).toEqual(["a", "b"]);
	});

	test("single add", () => {
		expect(reply(runTool(INITIAL_MODEL, { action: "add", text: "x" })).text).toBe("Added task #1: x");
	});

	test("ids are never reused after remove", () => {
		const m = run(withTasks("a", "b"), { action: "remove", id: 2 });
		expect(reply(runTool(m, { action: "add", text: "c" })).text).toBe("Added task #3: c");
	});
});

describe("toggle (T:485-527)", () => {
	test("missing and unknown id", () => {
		const a = reply(runTool(withTasks("a"), { action: "toggle" }));
		expect([a.text, a.details.error]).toEqual(["Error: id required for toggle", "id required"]);
		const b = reply(runTool(withTasks("a"), { action: "toggle", id: 9 }));
		expect([b.text, b.details.error, b.next]).toEqual(["Task #9 not found", "#9 not found", undefined]);
	});

	test("cycles idle, inprogress, done, idle", () => {
		let m = withTasks("a");
		const texts: string[] = [];
		for (let i = 0; i < 3; i++) {
			const r = reply(runTool(m, { action: "toggle", id: 1 }));
			texts.push(r.text);
			m = r.next!;
		}
		expect(texts).toEqual(["Task #1: idle → inprogress", "Task #1: inprogress → done", "Task #1: done → idle"]);
	});

	test("entering inprogress demotes the other active task", () => {
		const m = run(withTasks("a", "b"), { action: "toggle", id: 1 });
		const r = reply(runTool(m, { action: "toggle", id: 2 }));
		expect(r.text).toBe("Task #2: idle → inprogress\n(Auto-paused #1 → idle. Only one task can be in progress at a time.)");
		expect(statuses(r.next!)).toEqual(["1:idle", "2:inprogress"]);
	});

	test("restored data with several active tasks demotes all of them in order", () => {
		const m = restore(INITIAL_MODEL, [
			{ action: "add", nextId: 4, tasks: [{ id: 1, text: "a", status: "inprogress" }, { id: 2, text: "b", status: "inprogress" }, { id: 3, text: "c", status: "idle" }] },
		]);
		expect(reply(runTool(m, { action: "toggle", id: 3 })).text).toBe("Task #3: idle → inprogress\n(Auto-paused #1, #2 → idle. Only one task can be in progress at a time.)");
	});
});

describe("remove (T:529-550)", () => {
	test("errors", () => {
		expect(reply(runTool(withTasks("a"), { action: "remove" })).text).toBe("Error: id required for remove");
		expect(reply(runTool(withTasks("a"), { action: "remove", id: 9 })).text).toBe("Task #9 not found");
	});

	test("success keeps nextId", () => {
		const r = reply(runTool(withTasks("a", "b"), { action: "remove", id: 1 }));
		expect(r.text).toBe("Removed task #1: a");
		expect(r.details.nextId).toBe(3);
		expect(r.details.tasks).toEqual([{ id: 2, text: "b", status: "idle" }]);
	});
});

describe("update (T:552-580)", () => {
	test("error order: id, then text (empty counts), then lookup", () => {
		const m = withTasks("a");
		expect(reply(runTool(m, { action: "update", text: "x" })).text).toBe("Error: id required for update");
		expect(reply(runTool(m, { action: "update", id: 9 })).details.error).toBe("text required");
		expect(reply(runTool(m, { action: "update", id: 9, text: "" })).text).toBe("Error: text required for update");
		expect(reply(runTool(m, { action: "update", id: 9, text: "x" })).text).toBe("Task #9 not found");
	});

	test("success", () => {
		const r = reply(runTool(withTasks("a"), { action: "update", id: 1, text: "b" }));
		expect(r.text).toBe('Updated #1: "a" → "b"');
		expect(r.next!.list.tasks[0].text).toBe("b");
	});
});

describe("clear (T:582-609)", () => {
	test("empty untitled and titled-but-empty clear without asking", () => {
		const titled = step(INITIAL_MODEL, { action: "new-list", text: "T", description: "D" });
		for (const m of [INITIAL_MODEL, titled]) {
			const r = reply(runTool(m, { action: "clear" }));
			expect(r.text).toBe("Cleared 0 task(s)");
			expect(r.next!.list).toEqual({ tasks: [], nextId: 1, title: undefined, description: undefined });
		}
	});

	test("asks while a task is not done", () => {
		const m = run(INITIAL_MODEL, { action: "new-list", text: "T" }, { action: "add", texts: ["a", "b"] });
		const a = ask(runTool(m, { action: "clear" }));
		expect([a.title, a.message, a.timeoutMs]).toEqual(["Clear TillDone list?", 'This will remove all 2 task(s) from "T", 2 not done. Continue?', 30000]);
		expect(ask(runTool(withTasks("a"), { action: "clear" })).message).toBe("This will remove all 1 task(s), 1 not done. Continue?");
	});

	test("clears an all-done list without asking", () => {
		const done = run(withTasks("a"), { action: "toggle", id: 1 }, { action: "toggle", id: 1 });
		expect(reply(runTool(done, { action: "clear" })).text).toBe("Cleared 1 task(s)");
	});

	test("denied and granted", () => {
		const m = withTasks("a", "b");
		const no = runTool(m, { action: "clear" }, false);
		expect([no.text, no.details.error, no.next]).toEqual(["Clear cancelled by user.", "cancelled", undefined]);
		const yes = runTool(m, { action: "clear" }, true);
		expect(yes.text).toBe("Cleared 2 task(s)");
		expect(yes.next!.list).toEqual(INITIAL_MODEL.list);
	});

	test("the answer applies to the model passed in, not the one that asked", () => {
		ask(runTool(withTasks("a", "b"), { action: "clear" }));
		expect(runTool(INITIAL_MODEL, { action: "clear" }, true).text).toBe("Cleared 0 task(s)");
	});
});

describe("split", () => {
	test("errors: id, then at least two texts, then lookup, then done", () => {
		const m = run(withTasks("a"), { action: "toggle", id: 1 }, { action: "toggle", id: 1 });
		expect(reply(runTool(m, { action: "split", texts: ["x", "y"] })).text).toBe("Error: id required for split");
		const one = reply(runTool(m, { action: "split", id: 1, texts: ["x"] }));
		expect([one.text, one.details.error]).toEqual(["Error: texts (at least 2) required for split", "texts required"]);
		expect(reply(runTool(m, { action: "split", id: 9, texts: ["x", "y"] })).text).toBe("Task #9 not found");
		const done = reply(runTool(m, { action: "split", id: 1, texts: ["x", "y"] }));
		expect([done.text, done.details.error, done.next]).toEqual(["Task #1 is already done. Use add for new work instead of splitting it.", "#1 done", undefined]);
	});

	test("replaces the task in place with idle subtasks that record their origin", () => {
		const r = reply(runTool(withTasks("a", "b", "c"), { action: "split", id: 2, texts: ["b1", "b2"] }));
		expect(r.text).toBe("Split #2 into #4, #5");
		expect(r.next!.list.tasks).toEqual([
			{ id: 1, text: "a", status: "idle" },
			{ id: 4, text: "b1", status: "idle", from: 2 },
			{ id: 5, text: "b2", status: "idle", from: 2 },
			{ id: 3, text: "c", status: "idle" },
		]);
		expect(r.next!.list.nextId).toBe(6);
	});

	test("an in-progress task hands over to its first subtask, so the gate stays open", () => {
		const m = run(withTasks("a"), { action: "toggle", id: 1 });
		const r = reply(runTool(m, { action: "split", id: 1, texts: ["x", "y", "z"] }));
		expect(r.text).toBe("Split #1 into #2, #3, #4\n#2 is now in progress.");
		expect(statuses(r.next!)).toEqual(["2:inprogress", "3:idle", "4:idle"]);
		expect(gate(r.next!, "bash")).toEqual({ block: false });
	});

	test("origin shows in list text and survives a details round trip", () => {
		const m = step(withTasks("a"), { action: "split", id: 1, texts: ["x", "y"] });
		expect(reply(runTool(m, { action: "list" })).text).toBe("[○] #2 (idle, from #1): x\n[○] #3 (idle, from #1): y");
		const d = reply(runTool(m, { action: "list" })).details;
		expect(JSON.stringify(d.tasks[0])).toBe('{"id":2,"text":"x","status":"idle","from":1}');
		expect(restore(INITIAL_MODEL, [d]).list).toEqual(m.list);
		expect(parseDetails({ tasks: [{ id: 1, text: "a", status: "idle", from: "1" }], nextId: 2 })).toBeUndefined();
	});
});

describe("other actions", () => {
	test("consent on an action that never asks changes nothing", () => {
		const m = withTasks("a");
		expect(runTool(m, { action: "toggle", id: 1 }, false)).toEqual(reply(runTool(m, { action: "toggle", id: 1 })));
	});

	test("unknown action (T:611-615)", () => {
		const r = reply(runTool(withTasks("a"), { action: "bogus" } as unknown as Params));
		expect(r.text).toBe("Unknown action: bogus");
		expect(r.details.action).toBe("list");
		expect(r.details.error).toBe("unknown action: bogus");
		expect(r.details.tasks).toHaveLength(1);
		expect(r.next).toBeUndefined();
	});

	test("details JSON keeps the original makeDetails key order (T:168-175)", () => {
		const m = run(INITIAL_MODEL, { action: "new-list", text: "T", description: "D" }, { action: "add", text: "a" });
		expect(JSON.stringify(reply(runTool(m, { action: "toggle", id: 9 })).details)).toBe(
			'{"action":"toggle","tasks":[{"id":1,"text":"a","status":"idle"}],"nextId":2,"listTitle":"T","listDescription":"D","error":"#9 not found"}',
		);
		expect(Object.keys(reply(runTool(INITIAL_MODEL, { action: "list" })).details)).toEqual(["action", "tasks", "nextId", "listTitle", "listDescription"]);
	});
});

describe("B1: copy boundaries", () => {
	test("an earlier snapshot is not rewritten by a later toggle", () => {
		const added = reply(runTool(INITIAL_MODEL, { action: "add", text: "a" }));
		const toggled = reply(runTool(added.next!, { action: "toggle", id: 1 }));
		expect(toggled.details.tasks[0].status).toBe("inprogress");
		expect(added.details.tasks[0].status).toBe("idle");
	});

	test("mutating outbound details does not touch the model", () => {
		const r = reply(runTool(INITIAL_MODEL, { action: "add", text: "a" }));
		r.details.tasks[0].text = "hacked";
		r.details.tasks.push({ id: 9, text: "x", status: "idle" });
		expect(r.next!.list.tasks).toEqual([{ id: 1, text: "a", status: "idle" }]);
		expect(Object.isFrozen(r.details)).toBe(false);
	});

	test("mutating restored details does not touch the model", () => {
		const d = reply(runTool(INITIAL_MODEL, { action: "add", text: "a" })).details;
		const m = restore(INITIAL_MODEL, [d]);
		d.tasks[0].status = "done";
		d.tasks.push({ id: 9, text: "x", status: "idle" });
		expect(m.list.tasks).toEqual([{ id: 1, text: "a", status: "idle" }]);
		const next = step(m, { action: "add", text: "b" });
		expect(d.tasks).toHaveLength(2);
		expect(next.list.tasks).toHaveLength(2);
	});

	test("the model is deep-frozen", () => {
		const m = withTasks("a");
		expect(() => {
			(m.list.tasks[0] as { status: string }).status = "done";
		}).toThrow(TypeError);
		expect(() => (m.list.tasks as unknown[]).push({})).toThrow(TypeError);
		expect(() => {
			(m as { nudged: boolean }).nudged = true;
		}).toThrow(TypeError);
	});
});

describe("restore (T:302-323)", () => {
	const d = (title: string, n: number): Details => ({
		action: "add",
		tasks: Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `t${i + 1}`, status: "idle" as const })),
		nextId: n + 1,
		listTitle: title,
		listDescription: undefined,
	});

	test("empty branch gives the empty list", () => {
		expect(restore(withTasks("a"), []).list).toEqual(INITIAL_MODEL.list);
	});

	test("last snapshot wins", () => {
		expect(restore(INITIAL_MODEL, [d("A", 1), d("B", 2), d("C", 3)]).list.title).toBe("C");
	});

	test("malformed snapshots are skipped", () => {
		const bad = [null, { tasks: "x", nextId: 1 }, {}, { tasks: [{ id: "1", text: "a", status: "idle" }], nextId: 2 }, { tasks: [], nextId: 1, listTitle: 5 }];
		expect(restore(INITIAL_MODEL, [d("good", 2), ...bad]).list.title).toBe("good");
		for (const b of bad) expect(parseDetails(b)).toBeUndefined();
	});

	test("error details carry the list and restore it", () => {
		const m = run(INITIAL_MODEL, { action: "new-list", text: "T" }, { action: "add", text: "a" });
		const cancelled = runTool(m, { action: "clear" }, false).details;
		expect(restore(INITIAL_MODEL, [cancelled]).list).toEqual(m.list);
	});

	test("a details object without title keys restores as untitled", () => {
		expect(restore(INITIAL_MODEL, [{ action: "add", tasks: [], nextId: 3 }]).list).toEqual({ tasks: [], nextId: 3, title: undefined, description: undefined });
	});

	test("nudged is carried over", () => {
		const nudged = agentEnd(withTasks("a")).model;
		expect(restore(nudged, []).nudged).toBe(true);
	});
});

describe("gate (T:335-361)", () => {
	const noTasks =
		"🚫 No TillDone tasks defined. You MUST use `tilldone new-list` or `tilldone add` to define your tasks before using any other tools (read-only tools — read, grep, find, ls — stay available for planning). Plan your work first!";
	const allDone =
		"🚫 All TillDone tasks are done. You MUST use `tilldone add` for new tasks or `tilldone new-list` to start a fresh list before using any other tools (read-only tools — read, grep, find, ls — stay available for planning).";
	const noneActive = "🚫 No task is in progress. You MUST use `tilldone toggle` to mark a task as inprogress before doing any work.";

	test("tilldone always passes", () => {
		expect(gate(INITIAL_MODEL, "tilldone")).toEqual({ block: false });
	});

	test("reasons in order", () => {
		const m = withTasks("a");
		expect(gate(INITIAL_MODEL, "bash")).toEqual({ block: true, reason: noTasks });
		expect(gate(run(m, { action: "toggle", id: 1 }, { action: "toggle", id: 1 }), "bash")).toEqual({ block: true, reason: allDone });
		expect(gate(m, "bash")).toEqual({ block: true, reason: noneActive });
		expect(gate(run(m, { action: "toggle", id: 1 }), "bash")).toEqual({ block: false });
	});

	test("read-only tools pass without an active task, so a plan can be based on files", () => {
		const done = run(withTasks("a"), { action: "toggle", id: 1 }, { action: "toggle", id: 1 });
		for (const m of [INITIAL_MODEL, withTasks("a"), done]) {
			for (const tool of ["read", "grep", "find", "ls"]) expect(gate(m, tool)).toEqual({ block: false });
			for (const tool of ["bash", "edit", "write"]) expect(gate(m, tool).block).toBe(true);
		}
	});
});

describe("nudge latch (T:365-388)", () => {
	test("no nudge without incomplete tasks", () => {
		for (const m of [INITIAL_MODEL, run(withTasks("a"), { action: "toggle", id: 1 }, { action: "toggle", id: 1 })]) {
			const r = agentEnd(m);
			expect(r.nudge).toBeUndefined();
			expect(r.model.nudged).toBe(false);
		}
	});

	test("nudge text and message shape", () => {
		const m = run(withTasks("a", "b", "c"), { action: "toggle", id: 1 }, { action: "toggle", id: 3 }, { action: "toggle", id: 3 }, { action: "toggle", id: 3 });
		const r = agentEnd(run(m, { action: "toggle", id: 3 }, { action: "toggle", id: 3 }));
		expect(r.nudge).toEqual({
			customType: "tilldone-nudge",
			content:
				"⚠️ You still have 2 incomplete task(s):\n\n  ○ #1 [idle]: a\n  ○ #2 [idle]: b\n\nEither continue working on them or mark them done with `tilldone toggle`. Don't stop until it's done!",
			display: true,
		});
		expect(agentEnd(run(withTasks("a"), { action: "toggle", id: 1 })).nudge!.content).toContain("\n\n  ● #1 [in progress]: a\n\n");
	});

	test("once per input", () => {
		const first = agentEnd(withTasks("a"));
		expect(first.nudge).toBeDefined();
		expect(agentEnd(first.model).nudge).toBeUndefined();
		expect(agentEnd(userInput(first.model)).nudge).toBeDefined();
	});

	test("tool transitions keep the latch", () => {
		const nudged = agentEnd(withTasks("a")).model;
		expect(step(nudged, { action: "add", text: "b" }).nudged).toBe(true);
	});
});

describe("layering", () => {
	const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
	const importsFrom = (code: string, mod: string) =>
		[...code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)]
			.filter((m) => m[3] === mod)
			.flatMap((m) => m[2].split(",").map((s) => (m[1] ? `type ${s.trim()}` : s.trim())))
			.filter(Boolean);

	test("state.ts imports nothing", () => {
		expect(src("./state.ts")).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
	});

	test("ui.ts reads only types, selectors and the icon table from state.ts", () => {
		const values = importsFrom(src("./ui.ts"), "./state.ts").filter((n) => !n.startsWith("type "));
		expect(values.sort()).toEqual(["STATUS_ICON", "countByStatus", "current"]);
	});

	test("ui.ts never reaches L2", () => {
		expect(src("./ui.ts")).not.toMatch(/from\s+"\.\/index/);
	});
});
