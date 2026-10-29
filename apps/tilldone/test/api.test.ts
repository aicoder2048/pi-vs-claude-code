/** TillDone Desk L2/L3 tests: isolated Pi auth files and fake RPC pipes, never real credentials or models. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import lockfile from "proper-lockfile";
import { PiCredentials, piAuthPath } from "../src/credentials.ts";
import { API_PROVIDERS, parseCredentialChanges } from "../src/api-domain.ts";
import { initialState, parseIntent, planIntent, reduce, toViewModel } from "../src/domain.ts";
import { loadConfig } from "../src/config.ts";
import { Desk } from "../src/desk.ts";
import { PiProcess } from "../src/rpc.ts";
const openai = "sk-fake-openai-for-offline-tests";
const deepseek = "sk-fake-deepseek-for-offline-tests";
const replacement = "sk-fake-replacement-for-offline-tests";
const codex = { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 9999999999999 };
const input = (key = "", remove = false) => ({ key, remove });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(work: (path: string) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), "tilldone-pi-auth-"));
	try { await work(join(dir, "auth.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("Pi auth path uses the same home, tilde expansion, override, and child working directory", () => {
	expect(piAuthPath("/work", {}, "/home/me")).toBe("/home/me/.pi/agent/auth.json");
	expect(piAuthPath("/work", { PI_CODING_AGENT_DIR: "/custom" }, "/home/me")).toBe("/custom/auth.json");
	expect(piAuthPath("/work", { PI_CODING_AGENT_DIR: "~/pi" }, "/home/me")).toBe("/home/me/pi/auth.json");
	expect(piAuthPath("/work", { PI_CODING_AGENT_DIR: "relative" }, "/home/me")).toBe("/work/relative/auth.json");
});
test("API input validates both providers; blank keeps, deletion is explicit, and errors contain no key", () => {
	expect(parseCredentialChanges({ openai: input("  " + openai + "  "), deepseek: input() })).toEqual({ changes: { openai, deepseek: null } });
	expect(parseCredentialChanges({ openai: input("", true), deepseek: input() })).toEqual({ changes: { openai: "", deepseek: null } });
	for (const bad of ["bad key", "bad\nkey", "bad\\key", "中文", "x".repeat(513), "!command"]) expect(parseCredentialChanges({ openai: input(bad), deepseek: input() })).toEqual({ error: "invalidKey" });
	expect(parseCredentialChanges({ openai: input(openai, true), deepseek: input() })).toEqual({ error: "conflict" });
	expect(parseCredentialChanges({ openai: input(), deepseek: input(), anthropic: input() })).toEqual({ error: "invalidKey" });
});
test("save/replace/delete uses Pi's schema, preserves Codex and other providers, and reports environment fallback", async () => fixture(async (path) => {
	const other = { type: "api_key", key: "fake-other-provider", env: { REGION: "example" } };
	writeFileSync(path, JSON.stringify({ "openai-codex": codex, other }));
	const env = { OPENAI_API_KEY: "inherited-openai", DEEPSEEK_API_KEY: "inherited-deepseek" };
	const store = new PiCredentials(path, env);
	expect(store.summary().sources).toEqual({ openai: "environment", deepseek: "environment" });
	await store.save({ openai, deepseek });
	const disk = JSON.parse(readFileSync(path, "utf8"));
	expect(disk).toEqual({ "openai-codex": codex, other, openai: { type: "api_key", key: openai }, deepseek: { type: "api_key", key: deepseek } });
	if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	const restored = new PiCredentials(path, env);
	expect(restored.summary().sources).toEqual({ openai: "pi-key", deepseek: "pi-key" });
	expect(JSON.stringify(restored.summary())).not.toContain(openai);
	await restored.save({ openai: replacement, deepseek: null });
	expect(JSON.parse(readFileSync(path, "utf8")).deepseek.key).toBe(deepseek);
	const before = readFileSync(path, "utf8");
	await restored.save({ openai: null, deepseek: null });
	expect(readFileSync(path, "utf8")).toBe(before);
	await restored.save({ openai: "", deepseek: "" });
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "openai-codex": codex, other });
	expect(new PiCredentials(path, env).summary().sources).toEqual({ openai: "environment", deepseek: "environment" });
	expect(restored.redact(`${openai} ${replacement} ${deepseek}`)).toBe("[REDACTED] [REDACTED] [REDACTED]");
	expect(readdirSync(dirname(path))).toEqual(["auth.json"]);
}));
test("status inspection never executes command credentials or refreshes OAuth", async () => fixture(async (path) => {
	const marker = join(dirname(path), "must-not-exist");
	writeFileSync(path, JSON.stringify({ openai: { type: "api_key", key: `!touch ${marker}` }, deepseek: codex }));
	const store = new PiCredentials(path, {});
	expect(store.summary().sources).toEqual({ openai: "pi-command", deepseek: "pi-oauth" });
	expect(existsSync(marker)).toBe(false);
	const before = readFileSync(path, "utf8");
	await store.save({ openai: null, deepseek: null });
	expect(readFileSync(path, "utf8")).toBe(before);
}));
test("Pi-compatible lock prevents overwriting concurrent credential refreshes", async () => fixture(async (path) => {
	writeFileSync(path, JSON.stringify({ "openai-codex": codex }));
	const release = await lockfile.lock(path, { realpath: false });
	const store = new PiCredentials(path, {});
	const pending = store.save({ openai, deepseek: null });
	await Bun.sleep(30);
	const refreshed = { ...codex, access: "fake-concurrently-refreshed" };
	writeFileSync(path, JSON.stringify({ "openai-codex": refreshed, newProvider: { type: "api_key", key: "fake-new-provider" } }));
	await release(); await pending;
	const saved = JSON.parse(readFileSync(path, "utf8"));
	expect(saved["openai-codex"]).toEqual(refreshed);
	expect(saved.newProvider.key).toBe("fake-new-provider");
	expect(saved.openai.key).toBe(openai);
}));
test("malformed files, symlinks, held locks, and I/O failures leave original credentials intact", async () => fixture(async (path) => {
	writeFileSync(path, "invalid");
	const corrupt = new PiCredentials(path, {});
	expect(corrupt.summary().error).toBe("loadFailed");
	await expect(corrupt.save({ openai, deepseek })).rejects.toThrow("loadFailed");
	expect(readFileSync(path, "utf8")).toBe("invalid");
	writeFileSync(path, JSON.stringify({ "openai-codex": codex }));
	const link = path + ".link"; symlinkSync(path, link);
	await expect(new PiCredentials(link, {}).save({ openai, deepseek })).rejects.toThrow("loadFailed");
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "openai-codex": codex });
	const release = await lockfile.lock(path, { realpath: false });
	try { await expect(new PiCredentials(path, {}).save({ openai, deepseek })).rejects.toThrow("busy"); }
	finally { await release(); }
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "openai-codex": codex });
	await expect(new PiCredentials(join(path, "auth.json"), {}).save({ openai, deepseek })).rejects.toThrow("saveFailed");
}));
test("blank save with no auth file does not create a credential store", async () => fixture(async (path) => {
	const store = new PiCredentials(path, {});
	await store.save({ openai: null, deepseek: null });
	expect(existsSync(path)).toBe(false);
}));
test("API views contain only metadata; links are allowlisted and saving emits no RPC command", () => {
	let state = initialState("openai-codex/gpt-6.1-sol", "/work");
	state = reduce(state, { type: "desk_api_summary", summary: { authPath: "/temp/auth.json", error: null, sources: { openai: "pi-key", deepseek: "missing" } } });
	state = planIntent(state, parseIntent({ type: "apiOpen" })!).events.reduce(reduce, state);
	const plan = planIntent(state, parseIntent({ type: "apiSave", providers: { openai: input(openai), deepseek: input(deepseek) } })!);
	expect(plan.commands).toHaveLength(0); expect(plan.events).toHaveLength(0);
	expect(JSON.stringify(state)).not.toContain(openai);
	expect(JSON.stringify(toViewModel(state))).not.toContain(deepseek);
	expect(toViewModel(state).api.open).toBe(true);
	for (const provider of API_PROVIDERS) expect(planIntent(state, { type: "apiLink", provider: provider.id }).externalUrl).toBe(provider.url);
	expect(parseIntent({ type: "apiLink", provider: "https://evil.example" })).toBeUndefined();
	expect(parseIntent({ type: "apiLink", provider: "anthropic" })).toBeUndefined();
});
test("Desk saves to the same auth file seen by Pi without prompts, model switches, or env injection", async () => fixture(async (path) => {
	const app = resolve(import.meta.dir, "..");
	const config = loadConfig(app, { TILLDONE_PI_BIN: resolve(import.meta.dir, "fake-pi.ts") }, app);
	writeFileSync(path, JSON.stringify({ "openai-codex": codex }));
	const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dirname(path);
	const store = new PiCredentials(path, {});
	const views: string[] = []; const links: string[] = [];
	const desk = new Desk(config, (view) => views.push(JSON.stringify(view)), { credentials: store, openExternal: async (url) => { links.push(url); } });
	desk.start();
	try {
		const deadline = Date.now() + 4000;
		while (desk.view().connection !== "ready") { if (Date.now() > deadline) throw new Error("Fake Pi startup timed out"); await Bun.sleep(10); }
		const initialModel = desk.view().status.model;
		await desk.send({ type: "apiOpen" });
		await desk.send({ type: "apiSave", providers: { openai: input(openai), deepseek: input(deepseek) } });
		expect(desk.view().api.providers.every((p) => p.status.includes("未验证"))).toBe(true);
		expect(desk.view().status.model).toBe(initialModel); expect(desk.view().conversation).toHaveLength(0);
		expect(views.some((v) => v.includes(openai) || v.includes(deepseek))).toBe(false);
		await desk.send({ type: "apiLink", provider: "openai" }); expect(links).toEqual(["https://platform.openai.com/api-keys"]);
		const pi = new PiProcess(config, () => {}); pi.start();
		try { expect((await pi.request({ type: "auth_probe" })).data).toEqual({ openaiHash: hash(openai), deepseekHash: hash(deepseek), codexPresent: true }); }
		finally { await pi.stop(); }
	} finally {
		await desk.stop();
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
	}
}));
