/** TillDone Desk L2/L4 API smoke: isolated Pi auth.json and fake Pi, never real credentials or model calls. */
import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "tilldone-api-ui-"));
const agent = join(directory, "pi-agent");
await mkdir(agent);
const log = join(directory, "pi.jsonl");
const file = join(agent, "auth.json");
const openai = "sk-fake-ui-openai-not-a-real-key";
const deepseek = "sk-fake-ui-deepseek-not-a-real-key";
const replacement = "sk-fake-ui-replacement-not-a-real-key";
const preserved = { "openai-codex": { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 9999999999999 },
	other: { type: "api_key", key: "fake-unrelated-provider" } };
await writeFile(file, JSON.stringify(preserved));
const options: Parameters<typeof electron.launch>[0] = {
	executablePath: resolve(import.meta.dir, "../node_modules/.bin/electron"),
	args: [resolve(import.meta.dir, ".."), `--user-data-dir=${directory}`],
	env: { ...process.env, TILLDONE_PI_BIN: resolve(import.meta.dir, "fake-pi.ts"), TILLDONE_MODEL: "openai-codex/gpt-6.1-sol",
		TILLDONE_CWD: resolve(import.meta.dir, ".."), PI_CODING_AGENT_DIR: agent, OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "", FAKE_PI_LOG: log },
};
let application = await electron.launch(options);
try {
	let page = await application.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.waitForFunction(() => !(document.getElementById("send") as HTMLButtonElement).disabled);
	await application.evaluate(({ shell }) => {
		(globalThis as any).__openedApiLinks = [];
		shell.openExternal = async (url) => { (globalThis as any).__openedApiLinks.push(url); };
	});
	const open = async () => {
		await page.locator("#settings-toggle").click(); await page.locator("#api-open").click();
		await page.locator("#api-dialog[open]").waitFor();
	};
	assert.equal(await page.locator("header #api-open").count(), 0);
	await open();
	assert.equal(await page.locator("#settings-panel").isVisible(), false);
	assert.equal(await page.locator("#api-title").innerText(), "连接 AI 服务");
	assert.match(await page.locator("#api-billing").innerText(), /独立按量计费/);
	assert.match(await page.locator("#api-storage").innerText(), /auth.json.*明文/);
	assert.ok((await page.locator("#api-auth-path").innerText()).includes(file));
	for (const id of ["openai", "deepseek"]) {
		assert.equal(await page.locator(`#api-${id}-key`).inputValue(), "");
		assert.equal(await page.locator(`#api-${id}-key`).getAttribute("type"), "password");
		assert.equal(await page.locator(`#api-${id}-status`).innerText(), "未配置");
	}
	await page.locator("#api-openai-key").fill(openai);
	await page.locator("#api-openai-show").press("Enter");
	assert.equal(await page.locator("#api-openai-key").getAttribute("type"), "text");
	await page.locator("#api-openai-show").press("Enter");
	assert.equal(await page.locator("#api-openai-key").getAttribute("type"), "password");
	await page.locator("#api-close").click(); await open();
	assert.equal(await page.locator("#api-openai-key").inputValue(), "", "Cancel must discard drafts");
	await page.locator("#api-openai-link").click(); await page.locator("#api-deepseek-link").click();
	assert.deepEqual(await application.evaluate(() => (globalThis as any).__openedApiLinks), ["https://platform.openai.com/api-keys", "https://platform.deepseek.com/api_keys"]);
	assert.equal((await page.evaluate(() => window.tilldone.send({ type: "apiLink", provider: "https://evil.example" }))).ok, false);
	await page.evaluate(() => { (window as any).__apiViews = []; window.tilldone.onView((view) => (window as any).__apiViews.push(JSON.stringify(view))); });
	await page.locator("#api-openai-key").fill(openai); await page.locator("#api-deepseek-key").fill(deepseek);
	await page.locator("#api-save").click(); await page.locator("#api-saved").waitFor();
	const saved = await readFile(file, "utf8");
	assert.deepEqual(JSON.parse(saved), { ...preserved, openai: { type: "api_key", key: openai }, deepseek: { type: "api_key", key: deepseek } });
	for (const id of ["openai", "deepseek"]) {
		assert.equal(await page.locator(`#api-${id}-key`).inputValue(), "");
		assert.equal(await page.locator(`#api-${id}-status`).innerText(), "Pi 已保存 Key（未验证）");
	}
	assert.equal(await page.locator("#model").innerText(), "openai-codex/gpt-6.1-sol");
	assert.equal(await page.locator(".message").count(), 0);
	assert.equal(await page.evaluate(([a, b]) => (window as any).__apiViews.some((view: string) => view.includes(a) || view.includes(b)), [openai, deepseek]), false);
	await page.locator("#api-save").click(); await page.locator("#api-saved").waitFor();
	assert.equal(await readFile(file, "utf8"), saved, "Blank save preserves all credentials");
	await page.locator("#api-openai-key").fill(replacement); await page.locator("#api-openai-remove").check();
	await page.locator("#api-save").click(); await page.locator("#api-error").waitFor();
	assert.match(await page.locator("#api-error").innerText(), /替换.*删除/);
	assert.equal(await readFile(file, "utf8"), saved);
	await page.locator("#api-openai-remove").uncheck(); await page.locator("#api-openai-key").fill("invalid key");
	await page.locator("#api-save").click();
	await page.waitForFunction(() => document.getElementById("api-error")!.textContent!.includes("512"));
	assert.equal(await readFile(file, "utf8"), saved);
	await page.locator("#api-openai-key").fill(replacement); await page.locator("#api-save").click();
	await page.locator("#api-saved").waitFor();
	assert.equal(await page.locator("#api-openai-key").inputValue(), "");
	await page.locator("#api-dialog").evaluate((dialog) => { dialog.scrollTop = 0; });
	await page.screenshot({ path: join(tmpdir(), "tilldone-api-zh.png") });
	// A complete app restart reads the same standard Pi file, with no app-only secret storage.
	await application.close(); application = await electron.launch(options); page = await application.firstWindow();
	page.on("pageerror", (error) => errors.push(error.message));
	await page.waitForFunction(() => !(document.getElementById("send") as HTMLButtonElement).disabled);
	await open();
	assert.equal(await page.locator("#api-openai-key").inputValue(), "");
	assert.equal(await page.locator("#api-openai-status").innerText(), "Pi 已保存 Key（未验证）");
	await page.locator("#api-close").click(); await page.locator("#settings-toggle").click();
	await page.locator("#language").selectOption("en"); await page.waitForFunction(() => document.documentElement.lang === "en");
	await page.locator("#api-open").click(); await page.locator("#api-dialog[open]").waitFor();
	assert.equal(await page.locator("#api-title").innerText(), "Connect AI services");
	assert.match(await page.locator("#api-billing").innerText(), /billed separately/);
	await page.locator("#api-openai-remove").check(); await page.locator("#api-deepseek-remove").check();
	await page.locator("#api-save").click(); await page.locator("#api-saved").waitFor();
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), preserved);
	assert.equal(await page.locator("#api-openai-status").innerText(), "Not configured");
	await page.locator("#api-close").click();
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 700));
	for (const theme of ["paper", "night", "ink", "neon"]) {
		await page.locator(`#shortcut-${theme}`).click(); await page.waitForFunction((id) => document.documentElement.dataset.theme === id, theme);
		await open();
		assert.equal(await page.evaluate(() => { const d = document.getElementById("api-dialog")!; return d.scrollWidth <= d.clientWidth; }), true, `${theme}: no horizontal overflow`);
		await page.locator("#api-dialog").evaluate((dialog) => { dialog.scrollTop = 0; });
		await page.waitForTimeout(350); await page.screenshot({ path: join(tmpdir(), `tilldone-api-${theme}.png`) });
		await page.keyboard.press("Escape");
	}
	await writeFile(file, "intentionally-invalid-test-json");
	await open(); assert.equal(await page.locator("#api-save").isDisabled(), true);
	assert.match(await page.locator("#api-error").innerText(), /credential file/);
	await writeFile(file, JSON.stringify(preserved));
	const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.filter((r) => r.type === "launch").length, 2, "Only the explicit app restart should launch Pi again");
	assert.equal(records.some((r) => ["prompt", "set_model"].includes(r.type)), false);
	for (const key of [openai, deepseek, replacement]) assert.equal(JSON.stringify(records).includes(key), false);
	await assert.rejects(access(join(directory, "api-credentials.json")));
	assert.deepEqual(errors, []);
	console.log("Pi API settings Electron smoke passed (isolated auth.json + fake Pi; no real credentials/model calls).");
} catch (error) {
	const page = await application.firstWindow(); await page.screenshot({ path: join(tmpdir(), "tilldone-api-failure.png") }); throw error;
} finally { await application.close(); await rm(directory, { recursive: true, force: true }); }
