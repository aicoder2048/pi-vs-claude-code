#!/usr/bin/env bun
/** TillDone Desk L1 test double: deterministic RPC peer, no provider or model calls. */
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { JsonlDecoder } from "../src/jsonl.ts";
const records = readFileSync(new URL("fixtures/rpc-probe.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.dir === "out").map((r) => r.rec);
const state = records.find((r) => r.command === "get_state").data;
const emit = (record: object) => process.stdout.write(JSON.stringify(record) + "\n");
const log = (record: object) => { if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(record) + "\n"); };
log({ type: "launch", args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
const waits = new Map<string, () => void>();
// Steering messages wait here until the run ends, like Pi's queue during a long tool batch.
let steering: string[] = [];
const queueUpdate = () => emit({ type: "queue_update", steering, followUp: [] });
async function handle(r: any) {
	log(r);
	if (r.type === "extension_ui_response") { waits.get(r.id)?.(); return; }
	if (r.type === "get_state") { emit({ type: "response", command: r.type, id: r.id, success: true, data: state }); return; }
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
	if (r.message === "busy") { emit({ type: "agent_start" }); return; }
	if (r.message === "markup") {
		emit({ type: "message_start", message: { role: "user", content: '<img src=x onerror="alert(1)">' } });
		return;
	}
	// Echo an image prompt back as the user message Pi would record, so the desk can show it.
	if (r.images) { emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: r.message }, ...r.images] } }); return; }
	if (r.message === "tasks") {
		const details = { action: "add", tasks: [{ id: 1, text: "write the guide", status: "inprogress" }, { id: 2, text: "old", status: "done" }], nextId: 3, listTitle: "Split", listDescription: undefined };
		emit({ type: "tool_execution_end", toolCallId: "tasks", toolName: "tilldone", result: { content: [], details }, isError: false });
		// Past the split hint threshold, so the panel shows an emphasized count on the active task.
		for (let i = 0; i < 16; i++) {
			emit({ type: "tool_execution_start", toolCallId: `bash-${i}`, toolName: "bash", args: { command: "true" } });
			emit({ type: "tool_execution_end", toolCallId: `bash-${i}`, toolName: "bash", result: { content: [] }, isError: false });
		}
		return;
	}
	if (r.message.startsWith("Split task")) return;
	if (r.message === "expiry") { emit({ type: "extension_ui_request", method: "confirm", id: "expiry-id", title: "Timeout", message: "Close only", timeout: 100 }); return; }
	if (r.message === "dialogs") {
		for (const method of ["select", "input", "editor"]) emit({ type: "extension_ui_request", id: method, method, title: "Unsupported" });
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
