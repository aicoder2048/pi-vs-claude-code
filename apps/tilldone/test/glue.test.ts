/** TillDone Desk L2 tests: real pipes to an injected fake Pi, never a real model. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { JsonlDecoder } from "../src/jsonl.ts";
import { loadConfig } from "../src/config.ts";
import { PiProcess } from "../src/rpc.ts";
import { Desk } from "../src/desk.ts";
const app = resolve(import.meta.dir, "..");
const fake = resolve(import.meta.dir, "fake-pi.ts");
const config = () => loadConfig(app, { TILLDONE_PI_BIN: fake }, app);
async function until(predicate: () => boolean, timeout = 4000) {
	const end = Date.now() + timeout;
	while (!predicate()) { if (Date.now() > end) throw new Error("Wait timed out"); await Bun.sleep(10); }
}

test("JSONL: fragmented bytes, coalesced records, CRLF, U+2028/U+2029", () => {
	const records: any[] = [];
	const decoder = new JsonlDecoder((r) => records.push(r));
	const value = { text: "任务😀a\u2028b\u2029c" };
	const bytes = Buffer.from(JSON.stringify(value) + "\r\n");
	for (const byte of bytes) decoder.push(Buffer.from([byte]));
	decoder.push(Buffer.from('{"a":1}\n{"a":2}\n'));
	decoder.end();
	expect(records).toEqual([value, { a: 1 }, { a: 2 }]);
});
test("unterminated/malformed records are not silently accepted", () => {
	const decoder = new JsonlDecoder(() => {});
	decoder.push(Buffer.from('{"a":1}'));
	expect(() => decoder.end()).toThrow("unterminated");
	expect(() => new JsonlDecoder(() => {}).push(Buffer.from("nope\n"))).toThrow();
});
test("configuration defaults, overrides, extension resolution, and billing refusal", () => {
	const defaults = loadConfig(app, {}, "/tmp");
	expect(defaults.model).toBe("openai-codex/gpt-6.1-sol");
	expect(defaults.piBin).toBe("pi");
	expect(defaults.cwd).toBe("/tmp");
	expect(defaults.extension).toBe(resolve(app, "../../extensions/tilldone"));
	expect(loadConfig(app, { TILLDONE_MODEL: "openai-codex/custom", TILLDONE_CWD: "/work", TILLDONE_PI_BIN: fake }).piBin).toBe(fake);
	for (const model of ["anthropic/claude", " ANTHROPIC/anything "]) expect(() => loadConfig(app, { TILLDONE_MODEL: model })).toThrow("metered API");
});
test("command responses correlate by ID, not order; failures, timeouts and crashes reject", async () => {
	const records: any[] = [];
	const pi = new PiProcess(config(), (r) => records.push(r));
	pi.start();
	try {
		const slow = pi.request({ type: "slow" });
		const fast = pi.request({ type: "fast" });
		expect((await fast).command).toBe("fast");
		expect((await slow).command).toBe("slow");
		expect(records.filter((r) => r.type === "response").map((r) => r.command)).toEqual(["fast", "slow"]);
		await expect(pi.request({ type: "fail" })).rejects.toThrow("expected rejection");
		await expect(pi.request({ type: "hang" }, 30)).rejects.toThrow("timed out");
		await expect(pi.request({ type: "crash" })).rejects.toThrow("code 7");
		expect(records.some((r) => r.type === "desk_stderr" && r.text.includes("fake crash"))).toBe(true);
	} finally { await pi.stop(); }
});
test("spawn failure is observable and pending requests reject", async () => {
	const records: any[] = [];
	const pi = new PiProcess({ ...config(), piBin: "/not/a/pi" }, (r) => records.push(r));
	pi.start();
	try {
		await expect(pi.request({ type: "get_state" })).rejects.toThrow();
		await until(() => records.some((r) => r.type === "desk_exit"));
	} finally { await pi.stop(); }
});
test("fake Pi replay blocks for confirm; Desk echoes exact UI ID, cancels unsupported dialogs, restarts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tilldone-rpc-"));
	const log = join(dir, "stdin.jsonl");
	const old = process.env.FAKE_PI_LOG;
	process.env.FAKE_PI_LOG = log;
	let view: ReturnType<Desk["view"]>;
	const desk = new Desk(config(), (next) => { view = next; });
	const readLog = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	desk.start();
	try {
		await until(() => view?.connection === "ready");
		await desk.send({ type: "submit", mode: "steer", message: "/tilldone" });
		expect(view!.tasks.focus).toBe(1);
		expect(readLog().some((r) => r.message === "/tilldone")).toBe(false);
		await desk.send({ type: "submit", mode: "steer", message: "replay" });
		await until(() => Boolean(view!.confirm));
		const id = view!.confirm!.id;
		expect(id).toBe("7a978bb5-c471-4607-8090-15786d956978");
		expect(view!.tasks.total).toBe(2);
		await desk.send({ type: "confirm", id: "wrong", confirmed: true });
		expect(view!.confirm!.id).toBe(id);
		await desk.send({ type: "confirm", id, confirmed: true });
		await until(() => view!.conversation.at(-1)?.text === "ok" && !view!.status.running);
		expect(view!.tasks.total).toBe(0);
		expect(readLog().find((r) => r.type === "extension_ui_response")).toEqual({ type: "extension_ui_response", id, confirmed: true });
		await desk.send({ type: "submit", mode: "steer", message: "busy" });
		await until(() => view!.status.running);
		await desk.send({ type: "submit", mode: "steer", message: "redirect" });
		await desk.send({ type: "submit", mode: "followUp", message: "later" });
		await desk.send({ type: "abort" });
		await until(() => !view!.status.running);
		expect(readLog().filter((r) => ["steer", "follow_up", "clear_queue", "abort"].includes(r.type)).map((r) => r.type)).toEqual(["steer", "follow_up", "clear_queue", "abort"]);
		await expect(desk.send({ type: "set_model", provider: "anthropic" })).rejects.toThrow("Invalid desktop intent");
		await desk.send({ type: "submit", mode: "steer", message: "dialogs" });
		await until(() => readLog().filter((r) => r.cancelled === true).length === 3);
		expect(readLog().filter((r) => r.cancelled === true).map((r) => r.id)).toEqual(["select", "input", "editor"]);
		await desk.send({ type: "submit", mode: "steer", message: "expiry" });
		await until(() => view!.confirm?.id === "expiry-id");
		await until(() => !view!.confirm);
		expect(readLog().some((r) => r.type === "extension_ui_response" && r.id === "expiry-id")).toBe(false);
		const launches = readLog().filter((r) => r.type === "launch");
		expect(launches[0].args).toEqual(["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--model", config().model, "-e", config().extension]);
		expect(launches[0].cwd).toBe(app);
		await desk.stop();
		expect(view!.connection).toBe("exited");
		await desk.send({ type: "restart" });
		await until(() => view!.connection === "ready");
		expect(view!.conversation).toHaveLength(0);
		expect(readLog().filter((r) => r.type === "launch")).toHaveLength(2);
	} finally {
		await desk.stop();
		if (old === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = old;
		rmSync(dir, { recursive: true, force: true });
	}
});
