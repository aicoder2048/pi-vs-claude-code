/** TillDone Desk L2 tests: real pipes to an injected fake Pi, never a real model. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { JsonlDecoder } from "../src/jsonl.ts";
import { loadConfig, piArgs } from "../src/config.ts";
import { PiProcess } from "../src/rpc.ts";
import { Desk } from "../src/desk.ts";
import type { Entry, ToolGroup } from "../src/domain.ts";
/** The conversation's messages, without tool groups. */
const said = (view: { conversation: readonly (Entry | ToolGroup)[] }) => view.conversation.filter((e): e is Entry => e.kind !== "tools");
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
	expect(defaults.extension).toBe(resolve(app, "extensions/tilldone"));
	expect(loadConfig(app, { TILLDONE_MODEL: "openai-codex/custom", TILLDONE_CWD: "/work", TILLDONE_PI_BIN: fake }).piBin).toBe(fake);
	for (const model of ["anthropic/claude", " ANTHROPIC/anything "]) expect(() => loadConfig(app, { TILLDONE_MODEL: model })).toThrow("metered API");
});
test("pstack is off by default: launch args keep Pi isolated to the TillDone extension", () => {
	for (const flag of [undefined, "", "0"]) {
		const c = loadConfig(app, flag === undefined ? {} : { TILLDONE_PSTACK: flag }, "/tmp");
		expect(c.pstackExtension).toBeUndefined();
		expect(piArgs(c)).toEqual(["--mode", "rpc", "--no-extensions", "--model", c.model, "-e", c.extension]);
	}
});
test("TILLDONE_PSTACK=1 trusts project files and allowlists only the project-local pstack extension", () => {
	const work = mkdtempSync(join(tmpdir(), "tilldone-pstack-"));
	try {
		const extension = join(work, ".pi/npm/node_modules/pi-pstack/extensions/pstack");
		mkdirSync(extension, { recursive: true });
		const c = loadConfig(app, { TILLDONE_PSTACK: "1", TILLDONE_CWD: work }, "/tmp");
		expect(c.pstackExtension).toBe(extension);
		expect(piArgs(c)).toEqual(["--mode", "rpc", "--no-extensions", "--model", c.model, "-e", c.extension, "-e", extension, "-a"]);
		expect(piArgs(c, "/s.jsonl").slice(-3)).toEqual(["-a", "--session", "/s.jsonl"]);
	} finally { rmSync(work, { recursive: true, force: true }); }
});
test("TILLDONE_PSTACK fails fast when pstack is missing or the value is unrecognized", () => {
	const work = mkdtempSync(join(tmpdir(), "tilldone-nopstack-"));
	try {
		expect(() => loadConfig(app, { TILLDONE_PSTACK: "1", TILLDONE_CWD: work })).toThrow("pi install npm:pi-pstack -l");
		for (const flag of ["yes", "true", "2"]) expect(() => loadConfig(app, { TILLDONE_PSTACK: flag, TILLDONE_CWD: work })).toThrow("TILLDONE_PSTACK");
	} finally { rmSync(work, { recursive: true, force: true }); }
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
test("fake Pi replay blocks for confirm; Desk echoes exact UI ID, answers select/input/editor in order, restarts", async () => {
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
		await desk.send({ type: "submit", message: "/tilldone" });
		expect(view!.tasks.focus).toBe(1);
		expect(readLog().some((r) => r.message === "/tilldone")).toBe(false);
		await desk.send({ type: "submit", message: "replay" });
		await until(() => Boolean(view!.dialog));
		const id = view!.dialog!.id;
		expect(id).toBe("7a978bb5-c471-4607-8090-15786d956978");
		expect(view!.tasks.total).toBe(2);
		await desk.send({ type: "confirm", id: "wrong", confirmed: true });
		expect(view!.dialog!.id).toBe(id);
		await desk.send({ type: "confirm", id, confirmed: true });
		await until(() => said(view!).at(-1)?.text === "ok" && !view!.status.running);
		expect(view!.tasks.total).toBe(0);
		expect(readLog().find((r) => r.type === "extension_ui_response")).toEqual({ type: "extension_ui_response", id, confirmed: true });
		await desk.send({ type: "submit", message: "busy" });
		await until(() => view!.status.running);
		await desk.send({ type: "submit", message: "redirect" });
		await desk.send({ type: "submit", message: "later" });
		await desk.send({ type: "abort" });
		await until(() => !view!.status.running);
		expect(readLog().filter((r) => ["steer", "follow_up", "clear_queue", "abort"].includes(r.type)).map((r) => r.type)).toEqual(["steer", "steer", "clear_queue", "abort"]);
		await expect(desk.send({ type: "set_model", provider: "anthropic" })).rejects.toThrow("Invalid desktop intent");
		await desk.send({ type: "submit", message: "dialogs" });
		await until(() => view!.dialog?.id === "select");
		expect(readLog().find((r) => r.id === "bad-select" && r.type === "extension_ui_response")).toEqual({ type: "extension_ui_response", id: "bad-select", cancelled: true });
		expect(view!.dialog!.options).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-terra"]);
		await desk.send({ type: "answer", id: "select", value: "not offered" });
		expect(view!.dialog!.id).toBe("select");
		await desk.send({ type: "confirm", id: "select", confirmed: true });
		expect(view!.dialog!.id).toBe("select");
		await desk.send({ type: "answer", id: "select", value: "openai-codex/gpt-6.1-terra" });
		await until(() => view!.dialog?.id === "input");
		expect(view!.dialog!.placeholder).toBe("type a name");
		await desk.send({ type: "answer", id: "input", value: "collie" });
		await until(() => view!.dialog?.id === "editor");
		expect(view!.dialog!.prefill).toBe("line 1\nline 2");
		await desk.send({ type: "answer", id: "editor", value: null });
		await until(() => !view!.dialog && readLog().some((r) => r.id === "editor" && r.type === "extension_ui_response"));
		expect(readLog().filter((r) => r.type === "extension_ui_response" && ["select", "input", "editor"].includes(r.id))).toEqual([
			{ type: "extension_ui_response", id: "select", value: "openai-codex/gpt-6.1-terra" },
			{ type: "extension_ui_response", id: "input", value: "collie" },
			{ type: "extension_ui_response", id: "editor", cancelled: true },
		]);
		await desk.send({ type: "submit", message: "expiry" });
		await until(() => view!.dialog?.id === "expiry-id");
		await until(() => !view!.dialog);
		expect(readLog().some((r) => r.type === "extension_ui_response" && r.id === "expiry-id")).toBe(false);
		const launches = readLog().filter((r) => r.type === "launch");
		expect(launches[0].args).toEqual(["--mode", "rpc", "--no-extensions", "--model", config().model, "-e", config().extension]);
		expect(launches[0].cwd).toBe(app);
		await desk.send({ type: "submit", message: "markup" });
		await until(() => view!.conversation.length > 0);
		await desk.send({ type: "newSession" });
		await until(() => view!.connection === "ready");
		expect(view!.conversation).toHaveLength(0);
		expect(readLog().filter((r) => r.type === "launch")).toHaveLength(2);
		await desk.stop();
		expect(view!.connection).toBe("exited");
		await desk.send({ type: "restart" });
		await until(() => view!.connection === "ready");
		// The fake reports no session file, so there is nothing to resume: a fresh session and one notice.
		expect(view!.conversation.map((m) => m.kind)).toEqual(["notice"]);
		expect(readLog().filter((r) => r.type === "launch")).toHaveLength(3);
	} finally {
		await desk.stop();
		if (old === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = old;
		rmSync(dir, { recursive: true, force: true });
	}
});
test("Restart after a crash resumes the crashed session file; New session and a missing file start fresh", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tilldone-resume-"));
	const log = join(dir, "stdin.jsonl");
	const session = join(dir, "session.jsonl");
	writeFileSync(session, "");
	const old = { log: process.env.FAKE_PI_LOG, session: process.env.FAKE_PI_SESSION };
	process.env.FAKE_PI_LOG = log;
	process.env.FAKE_PI_SESSION = session;
	let view: ReturnType<Desk["view"]>;
	const desk = new Desk(config(), (next) => { view = next; });
	const launches = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "launch").map((r) => r.args as string[]);
	const crash = async () => {
		await desk.send({ type: "submit", message: "crash" });
		await until(() => view!.connection === "exited");
	};
	desk.start();
	try {
		await until(() => view?.connection === "ready");
		await crash();
		await desk.send({ type: "restart" });
		await until(() => view!.connection === "ready");
		expect(launches()[1].slice(-2)).toEqual(["--session", session]);
		expect(view!.conversation).toHaveLength(0);
		// New session never resumes, even though Pi reported a session file.
		process.env.FAKE_PI_SESSION = join(dir, "never-written.jsonl");
		await desk.send({ type: "newSession" });
		await until(() => view!.connection === "ready");
		expect(launches()[2]).not.toContain("--session");
		// A crash before the first message reached disk leaves no file to resume.
		await crash();
		await desk.send({ type: "restart" });
		await until(() => view!.connection === "ready");
		expect(launches()[3]).not.toContain("--session");
		expect(view!.conversation.map((m) => m.kind)).toEqual(["notice"]);
	} finally {
		await desk.stop();
		for (const [key, value] of [["FAKE_PI_LOG", old.log], ["FAKE_PI_SESSION", old.session]] as const) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
test("Desk coalesces streamed records and stays quiet while idle", async () => {
	let views = 0, last: ReturnType<Desk["view"]> | undefined;
	const desk = new Desk(config(), (view) => { views++; last = view; });
	desk.start();
	try {
		await until(() => last?.connection === "ready");
		await desk.send({ type: "submit", message: "replay" });
		await until(() => Boolean(last?.dialog));
		// The replay bursts ~150 records before the confirm; a view per record would publish that many.
		expect(views).toBeLessThan(20);
		await desk.send({ type: "confirm", id: last!.dialog!.id, confirmed: true });
		await until(() => said(last!).at(-1)?.text === "ok" && !last!.status.running);
		await Bun.sleep(300);
		const settled = views;
		// Idle: 250 ms clock ticks and 2 s state polls change nothing visible.
		await Bun.sleep(2500);
		expect(views).toBe(settled);
	} finally { await desk.stop(); }
});
test("Desk copies an assistant reply's Markdown through the injected clipboard", async () => {
	const copied: string[] = [];
	let last: ReturnType<Desk["view"]> | undefined;
	const desk = new Desk(config(), (view) => { last = view; }, { writeClipboard: (text) => { copied.push(text); } });
	desk.start();
	try {
		await until(() => last?.connection === "ready");
		await desk.send({ type: "submit", message: "markdown" });
		await until(() => Boolean(last && said(last).some((e) => e.copyable && e.text.includes("<img"))));
		const reply = said(last!).find((e) => e.copyable)!;
		await desk.send({ type: "copyMessage", id: reply.id });
		expect(copied).toEqual([reply.text]);
		expect(copied[0]).toStartWith("## 周度小结\n\n第一行\n");
		// Naming a message that cannot be copied writes nothing.
		await desk.send({ type: "copyMessage", id: "message-404" });
		expect(copied).toHaveLength(1);
	} finally { await desk.stop(); }
});
test("Desk reports a copy it cannot perform instead of pretending it worked", async () => {
	let last: ReturnType<Desk["view"]> | undefined;
	const desk = new Desk(config(), (view) => { last = view; }, { writeClipboard: () => { throw new Error("denied"); } });
	desk.start();
	try {
		await until(() => last?.connection === "ready");
		await desk.send({ type: "submit", message: "markdown" });
		await until(() => Boolean(last && said(last).some((e) => e.copyable && e.text.includes("<img"))));
		await expect(desk.send({ type: "copyMessage", id: said(last!).find((e) => e.copyable)!.id })).rejects.toThrow("Cannot copy");
	} finally { await desk.stop(); }
});
test("with pstack each session's first prompt reaches Pi with the skill prefix, later ones do not", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tilldone-poteto-"));
	const log = join(dir, "stdin.jsonl");
	const old = process.env.FAKE_PI_LOG;
	process.env.FAKE_PI_LOG = log;
	let view: ReturnType<Desk["view"]>;
	// Any existing directory stands in for the pstack extension; fake Pi ignores -e.
	const desk = new Desk({ ...config(), pstackExtension: app }, (next) => { view = next; });
	const prompts = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "prompt").map((r) => r.message);
	desk.start();
	try {
		await until(() => view?.connection === "ready");
		expect(view!.poteto).toEqual({ available: true, active: false });
		await desk.send({ type: "submit", message: "/do it" });
		await desk.send({ type: "submit", message: "plan the work" });
		await desk.send({ type: "submit", message: "/next" });
		await until(() => view!.conversation.length === 3);
		expect(said(view!).map((m) => m.text)).toEqual(["/do it", "/skill:poteto-mode plan the work", "/next"]);
		expect(view!.poteto.active).toBe(true);
		await desk.send({ type: "newSession" });
		await until(() => view?.connection === "ready" && view.conversation.length === 0);
		expect(view!.poteto).toEqual({ available: true, active: false });
		await desk.send({ type: "submit", message: "again" });
		await until(() => prompts().length === 4);
		expect(prompts()).toEqual(["/do it", "/skill:poteto-mode plan the work", "/next", "/skill:poteto-mode again"]);
	} finally {
		await desk.stop();
		if (old === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = old;
		rmSync(dir, { recursive: true, force: true });
	}
});
