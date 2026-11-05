#!/usr/bin/env bun
/** TillDone Desk L1 test double: deterministic RPC peer, no provider or model calls. */
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { JsonlDecoder } from "../src/jsonl.ts";
const records = readFileSync(new URL("fixtures/rpc-probe.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.dir === "out").map((r) => r.rec);
const state = records.find((r) => r.command === "get_state").data;
const emit = (record: object) => process.stdout.write(JSON.stringify(record) + "\n");
const log = (record: object) => { if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(record) + "\n"); };
log({ type: "launch", args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
// Like Pi: a resumed process reports the file it was given; otherwise the file a fresh session would use.
const sessionArg = process.argv.indexOf("--session");
const sessionFile = sessionArg >= 0 ? process.argv[sessionArg + 1] : process.env.FAKE_PI_SESSION;
const waits = new Map<string, () => void>();
// Steering messages wait here until the run ends, like Pi's queue during a long tool batch.
let steering: string[] = [];
const queueUpdate = () => emit({ type: "queue_update", steering, followUp: [] });
async function handle(r: any) {
	log(r);
	if (r.type === "extension_ui_response") { waits.get(r.id)?.(); return; }
	if (r.type === "get_state") { emit({ type: "response", command: r.type, id: r.id, success: true, data: sessionFile ? { ...state, sessionFile } : state }); return; }
	if (r.type === "auth_probe") {
		if (!process.env.PI_CODING_AGENT_DIR) throw new Error("Auth probes require an isolated agent directory");
		const auth = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
		const hash = (value = "") => createHash("sha256").update(value).digest("hex");
		emit({ type: "response", command: r.type, id: r.id, success: true, data: { openaiHash: hash(auth.openai?.key), deepseekHash: hash(auth.deepseek?.key), codexPresent: auth["openai-codex"]?.type === "oauth" } });
		return;
	}
	if (r.type === "hang") return;
	if (r.type === "fail") { emit({ type: "response", command: r.type, id: r.id, success: false, error: "expected rejection" }); return; }
	if (r.type === "crash") { process.stderr.write("fake crash diagnostic\n"); process.exit(7); }
	if (r.type === "slow") await Bun.sleep(60);
	emit({ type: "response", command: r.type, id: r.id, success: true });
	if (r.type === "steer") { steering = [...steering, r.message]; queueUpdate(); return; }
	if (r.type === "clear_queue") { steering = []; queueUpdate(); return; }
	if (r.type === "abort") { emit({ type: "agent_settled", aborted: true }); return; }
	if (r.type !== "prompt") return;
	if (r.message === "crash") process.exit(9);
	// Slash commands: echo the user message Pi would record; /skill:name expands like Pi does.
	if (r.message.startsWith("/")) {
		const skill = /^\/skill:([\w-]+)\s?([\s\S]*)$/.exec(r.message);
		const text = skill ? `<skill name="${skill[1]}" location="/fake/${skill[1]}/SKILL.md">\n(fake skill body)\n</skill>\n\n${skill[2]}` : r.message;
		emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
		return;
	}
	if (r.message === "busy") { emit({ type: "agent_start" }); return; }
	if (r.message === "markdown") {
		// Local file links point into the smoke test's own temp directory, which it fills before asking.
		const dir = process.env.FAKE_PI_LOG ? dirname(process.env.FAKE_PI_LOG) : "/tmp";
		const text = "## 周度小结\n\n第一行\n第二行，**加粗** 和 `inline`\n\n- 一\n- [x] 二\n\n| 指标 | 数值 |\n|:--|--:|\n| 收盘 | 135.2 |\n\n```ts\nconst a = 1 < 2;\n```\n\n> 引用\n\n见 [文档](https://example.com/docs)。<img src=x onerror=\"alert(1)\"> [脚本](javascript:alert(1))" +
			`\n\n文件：[行程 PDF](<${dir}/行程 报告.pdf>)、[启动脚本](${dir}/run.command)、[已删除](${dir}/gone.pdf)`;
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		// Stream in pieces first, so the half-written Markdown renders on the way.
		for (let i = 0; i < text.length; i += 40) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(i, i + 40) } });
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
		return;
	}
	if (r.message === "markup") {
		emit({ type: "message_start", message: { role: "user", content: '<img src=x onerror="alert(1)">' } });
		return;
	}
	// Echo an image prompt back as the user message Pi would record, so the desk can show it.
	if (r.images) { emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: r.message }, ...r.images] } }); return; }
	if (r.message === "tasks") {
		const list = (tasks: object[]) => emit({ type: "tool_execution_end", toolCallId: `tasks-${tasks.length}`, toolName: "tilldone", isError: false,
			result: { content: [], details: { action: "update", tasks, nextId: 3, listTitle: "Split", listDescription: undefined } } });
		const reply = (text: string) => {
			emit({ type: "message_start", message: { role: "assistant", content: [] } });
			emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
		};
		// Task 2 says one thing and calls no tools, so filtering on it leaves a single message.
		list([{ id: 1, text: "write the guide", status: "idle" }, { id: 2, text: "old", status: "inprogress" }]);
		reply("Old notes are already tidy.");
		list([{ id: 1, text: "write the guide", status: "inprogress" }, { id: 2, text: "old", status: "done" }]);
		// Past the split hint threshold, so the panel shows an emphasized count on the active task.
		// Each turn makes one model request and calls one tool: six reads, a reply, then an edit and nine commands, the last failing.
		const calls: [string, object][] = [
			...["guide.md", "outline.md", "notes.md", "style.md", "faq.md", "index.md"].map((file): [string, object] => ["read", { path: `/work/docs/${file}` }]),
			["edit", { path: "/work/docs/guide.md" }], ["bash", { command: "bun run lint" }],
			...Array.from({ length: 7 }, (): [string, object] => ["bash", { command: "true" }]), ["bash", { command: "bun test" }],
		];
		calls.forEach(([toolName, args], i) => {
			if (i === 6) reply("Draft is ready; checking the build.");
			emit({ type: "turn_start" });
			emit({ type: "tool_execution_start", toolCallId: `call-${i}`, toolName, args });
			emit({ type: "tool_execution_end", toolCallId: `call-${i}`, toolName, result: { content: [{ type: "text", text: i === calls.length - 1 ? "1 test failed" : "ok" }] }, isError: i === calls.length - 1 });
		});
		return;
	}
	if (r.message === "subagents") {
		// pstack's parallel subagent call as its partial results report it: queued, working, finished, and one quiet child waiting on its own delegation.
		const now = Date.now();
		const usage = (u: object = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...u });
		const queued = (agent: string) => ({ agent, source: "pending", task: "review", exitCode: -1, messages: [], stderr: "", usage: usage() });
		const prompt = (at: number) => ({ role: "user", content: [{ type: "text", text: "task" }], timestamp: at });
		const working = { agent: "poteto-agent", source: "bundled", task: "dig", model: "openai-codex/gpt-6.1-sol", exitCode: 0, stderr: "", usage: usage({ input: 30000, output: 1500, cacheRead: 9000, turns: 7 }),
			messages: [prompt(now - 190_000), { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "rg -n activity src" } }], stopReason: "toolUse", timestamp: now - 3000, durationMs: 2000 }] };
		const finished = { agent: "explorer", source: "bundled", task: "find", model: "deepseek/deepseek-v4", exitCode: 0, stderr: "", usage: usage({ input: 8000, output: 600, turns: 2 }),
			messages: [prompt(now - 190_000), { role: "assistant", content: [{ type: "text", text: "The reducer lives in src/domain.ts." }], stopReason: "stop", timestamp: now - 120_000, durationMs: 4000 }] };
		const nesting = { agent: "architect", source: "bundled", task: "design", model: "openai-codex/gpt-6.1-terra", exitCode: 0, stderr: "", usage: usage({ input: 12000, output: 900, turns: 3 }),
			messages: [prompt(now - 400_000), { role: "assistant", content: [{ type: "toolCall", name: "subagent", arguments: { agent: "poteto-agent", task: "prototype" } }], stopReason: "toolUse", timestamp: now - 300_000, durationMs: 5000 }] };
		const update = (results: object[]) => emit({ type: "tool_execution_update", toolCallId: "sub", toolName: "subagent", args: { tasks: [] }, partialResult: { content: [], details: { results } } });
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		emit({ type: "tool_execution_start", toolCallId: "sub", toolName: "subagent", args: { tasks: [{ agent: "poteto-agent", task: "dig" }, { agent: "explorer", task: "find" }, { agent: "architect", task: "design" }, { agent: "reviewer", task: "review" }] } });
		update([queued("poteto-agent"), queued("explorer"), queued("architect"), queued("reviewer")]);
		update([working, finished, nesting, queued("reviewer")]);
		return;
	}
	if (r.message === "nudge") {
		// A run that ends with two tasks open, the extension's nudge, and a second run that finishes only one of them.
		const list = (tasks: object[]) => emit({ type: "tool_execution_end", toolCallId: `nudge-${JSON.stringify(tasks).length}`, toolName: "tilldone", isError: false,
			result: { content: [], details: { action: "update", tasks, nextId: 4, listTitle: "Nudge", listDescription: undefined } } });
		emit({ type: "agent_start" });
		list([{ id: 1, text: "draft", status: "done" }, { id: 2, text: "review", status: "inprogress" }, { id: 3, text: "publish", status: "idle" }]);
		emit({ type: "agent_end" });
		emit({ type: "message_start", message: { role: "custom", customType: "tilldone-nudge", content: "⚠️ You still have 2 incomplete task(s):\n\n  ● #2 [in progress]: review\n  ○ #3 [idle]: publish\n\nEither continue working on them or mark them done with `tilldone done`. Don't stop until it's done!" } });
		list([{ id: 1, text: "draft", status: "done" }, { id: 2, text: "review", status: "done" }, { id: 3, text: "publish", status: "idle" }]);
		emit({ type: "agent_end" });
		emit({ type: "agent_settled" });
		return;
	}
	if (r.message.startsWith("Split task")) return;
	if (r.message === "expiry") { emit({ type: "extension_ui_request", method: "confirm", id: "expiry-id", title: "Timeout", message: "Close only", timeout: 100 }); return; }
	if (r.message === "dialogs") {
		// An unusable select is cancelled at once; the others block until answered, in order, like real extension calls.
		emit({ type: "extension_ui_request", id: "bad-select", method: "select", title: "No options", options: [] });
		for (const request of [
			{ id: "select", method: "select", title: "Model for judge", options: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-terra"] },
			{ id: "input", method: "input", title: "Name", placeholder: "type a name" },
			{ id: "editor", method: "editor", title: "Notes", prefill: "line 1\nline 2" },
		]) {
			const answer = new Promise<void>((resolve) => waits.set(request.id, resolve));
			emit({ type: "extension_ui_request", ...request });
			await answer;
			waits.delete(request.id);
		}
		return;
	}
	for (const record of records) {
		if (record.type === "response") continue;
		if (record.type === "extension_ui_request" && record.method === "confirm") {
			const answer = new Promise<void>((resolve) => waits.set(record.id, resolve));
			emit(record);
			await answer;
			waits.delete(record.id);
		} else emit(record);
	}
}
const decoder = new JsonlDecoder((r) => { void handle(r); });
process.stdin.on("data", (chunk) => decoder.push(chunk));
process.stdin.on("end", () => process.exit(0));
