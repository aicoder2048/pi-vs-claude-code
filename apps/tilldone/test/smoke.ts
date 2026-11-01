/** TillDone Desk L2/L4 smoke: real sandboxed Electron window with a fake Pi, no model calls. */
import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "tilldone-ui-"));
const log = join(directory, "pi.jsonl");
const launchOptions: Parameters<typeof electron.launch>[0] = {
	executablePath: resolve(import.meta.dir, "../node_modules/.bin/electron"),
	args: [resolve(import.meta.dir, ".."), `--user-data-dir=${directory}`],
	env: { ...process.env, TILLDONE_PI_BIN: resolve(import.meta.dir, "fake-pi.ts"), TILLDONE_MODEL: "openai-codex/gpt-6.1-sol", FAKE_PI_LOG: log, PI_CODING_AGENT_DIR: join(directory, "pi-agent"), OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "" },
};
let application = await electron.launch(launchOptions);
try {
	const page = await application.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", (error) => { errors.push(error.message); console.error("Page error", error.message); });
	page.on("console", (message) => console.log("Page console", message.text()));
	application.process().stderr?.on("data", (chunk) => console.error(String(chunk)));
	console.log("Smoke: window opened");
	await page.locator("#send").waitFor();
	await page.waitForFunction(() => !(document.querySelector("#send") as HTMLButtonElement).disabled);
	console.log("Smoke: Pi connected");
	assert.equal(await page.title(), "边牧任务桌面");
	assert.equal(await page.locator("#product-name").innerText(), "边牧任务桌面");
	assert.equal(await page.locator("#brand-slogan").innerText(), "羊不进圈，边牧不歇");
	assert.equal(await page.locator("#brand-logo-title").textContent(), "AI 边牧标志");
	assert.equal(await page.locator('svg#brand-logo[role="img"]').count(), 1);
	assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), "边牧任务桌面");
	assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
	assert.equal(await page.locator("#send").innerText(), "发送");
	assert.equal(await page.locator("#theme").inputValue(), "system");
	assert.equal(await page.locator("header select, #focus-tasks").count(), 0);
	assert.equal(await page.locator("#settings-panel").isVisible(), false);
	await page.locator("#settings-toggle").click();
	assert.equal(await page.locator("#settings-panel").isVisible(), true);
	assert.equal(await page.locator("#theme-system").textContent(), "系统");
	assert.equal(await page.locator("#language-label").textContent(), "语言");
	assert.equal(await page.locator('#language option[value="zh-CN"]').textContent(), "中文");
	const themeRow = await page.locator("#theme").boundingBox();
	const languageRow = await page.locator("#language").boundingBox();
	assert.ok(themeRow && languageRow && languageRow.y >= themeRow.y + themeRow.height, "Settings must use separate rows");
	// Native select popups are invalidated when unchanged options are rewritten.
	// Keep the menu open across clock/state updates and detect both option mutations
	// and redundant value assignments (neither is visible to selectOption tests).
	await page.locator("#theme").click();
	const dropdownUpdates = await page.evaluate(async () => {
		const select = document.getElementById("theme") as HTMLSelectElement;
		const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!;
		let valueWrites = 0;
		let mutations = 0;
		Object.defineProperty(select, "value", {
			configurable: true,
			get() { return descriptor.get!.call(this); },
			set(value) { valueWrites++; descriptor.set!.call(this, value); },
		});
		const observer = new MutationObserver((records) => { mutations += records.length; });
		observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true });
		try {
			await new Promise((resolve) => setTimeout(resolve, 1200));
			return { mutations, valueWrites };
		} finally { observer.disconnect(); Reflect.deleteProperty(select, "value"); }
	});
	await page.keyboard.press("Escape");
	assert.deepEqual(dropdownUpdates, { mutations: 0, valueWrites: 0 }, "Unchanged views must not disturb the open theme menu");
	if (!await page.locator("#settings-panel").isVisible()) await page.locator("#settings-toggle").click();
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
	await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
	await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });
	await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
	await page.locator("#theme").selectOption("dark");
	await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
	await page.locator("#theme").selectOption("light");
	await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
	await page.locator("#language").selectOption("en");
	await page.waitForFunction(() => document.documentElement.lang === "en");
	assert.equal(await page.locator("#send").innerText(), "Send");
	assert.equal(await page.locator("#theme-light").innerText(), "Light");
	assert.equal(await page.locator("#settings-label").innerText(), "Settings");
	assert.equal(await page.title(), "TillDone Desk");
	assert.equal(await page.locator("#product-name").innerText(), "TillDone Desk");
	assert.equal(await page.locator("#brand-slogan").innerText(), "Don't stop until it's done");
	assert.equal(await page.locator("#brand-logo-title").textContent(), "AI border collie logo");
	assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), "TillDone Desk");
	assert.equal(await page.locator("#settings-panel").isVisible(), true);
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#settings-panel").isVisible(), false);
	await page.locator("#settings-toggle").click();
	await page.locator("header h1").click();
	assert.equal(await page.locator("#settings-panel").isVisible(), false);
	assert.equal(await page.locator("#theme option").count(), 7);
	assert.equal(await page.locator(".theme-swatch").count(), 4);
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 700));
	const switcher = await page.locator("#theme-shortcuts").boundingBox();
	const settings = await page.locator("#settings-toggle").boundingBox();
	assert.ok(switcher && settings && switcher.x + switcher.width <= settings.x, "Theme shortcuts must stay left of Settings at minimum width");
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850));
	await page.evaluate(() => {
		const animate = document.body.animate.bind(document.body);
		(window as any).__themeAnimationCalls = 0;
		document.body.animate = (...args) => { (window as any).__themeAnimationCalls++; return animate(...args); };
	});
	for (const [id, label, paper, accent] of [
		["paper", "Paper", "#f7f5f0", "#a34432"], ["night", "Night", "#0b1020", "#e0b755"],
		["ink", "Ink", "#f8f7f2", "#b8262b"], ["neon", "Neon", "#07070d", "#22e3ff"],
	]) {
		await page.locator(`#shortcut-${id}`).click();
		await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, id);
		assert.equal(await page.locator(`#shortcut-label-${id}`).innerText(), label);
		assert.equal(await page.locator(`#shortcut-${id}`).getAttribute("aria-pressed"), "true");
		assert.equal(await page.locator('.theme-swatch[aria-pressed="true"]').count(), 1);
		assert.equal(await page.locator("#theme").inputValue(), id);
		assert.deepEqual(await page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			return [style.getPropertyValue("--paper").trim(), style.getPropertyValue("--accent").trim()];
		}), [paper, accent]);
		await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 700));
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${id}: no overflow at minimum width`);
		await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850));
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(tmpdir(), `tilldone-theme-${id}.png`) });
	}
	await page.waitForTimeout(1100);
	assert.equal(await page.evaluate(() => (window as any).__themeAnimationCalls), 4, "Animate once per skin change, never on clock updates");
	// Switching skins must preserve drafts and tool state, not recreate the renderer.
	await page.locator("#prompt").fill("preserve this draft");
	await page.locator("#shortcut-paper").click();
	await page.waitForFunction(() => document.documentElement.dataset.theme === "paper");
	assert.equal(await page.locator("#prompt").inputValue(), "preserve this draft");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.locator("#shortcut-night").click();
	await page.waitForFunction(() => document.documentElement.dataset.theme === "night");
	assert.equal(await page.evaluate(() => document.body.getAnimations().some((animation) => animation.id === "theme-switch")), false);
	assert.equal(await page.evaluate(() => getComputedStyle(document.body).transitionDuration), "0s");
	assert.equal(await page.evaluate(() => (window as any).__themeAnimationCalls), 5, "Reduced motion must not start another fade");
	await page.evaluate(() => { Reflect.deleteProperty(document.body, "animate"); delete (window as any).__themeAnimationCalls; });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	assert.equal(await page.evaluate(() => typeof (window as any).require), "undefined");
	assert.deepEqual(await page.evaluate(() => Object.keys(window.tilldone).sort()), ["onView", "send"]);
	const preferences = await application.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
	assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
	await page.locator("#prompt").fill("/tilldone");
	await page.locator("#send").click();
	await page.locator("#tasks").evaluate((el) => { if (el !== document.activeElement) throw new Error("Task panel not focused"); });
	await page.locator("#prompt").fill("replay");
	await page.locator("#send").click();
	console.log("Smoke: replay submitted");
	await page.locator("#confirm-dialog[open]").waitFor();
	assert.match(await page.locator("#confirm-message").innerText(), /remove all 2 task/);
	assert.match(await page.locator("#countdown").innerText(), /Closes in/);
	assert.equal(await page.locator("#task-list li").count(), 2);
	assert.equal(await page.locator("#task-list li button.split").count(), 0, "Done tasks offer no split button");
	assert.equal(await page.locator("details.tool[open]").count(), 0);
	await page.locator("#allow").click();
	await page.locator("#confirm-dialog").waitFor({ state: "hidden" });
	await page.waitForFunction(() => document.getElementById("conversation")!.textContent!.includes("ok"));
	// Views are coalesced, so wait for the cleared list instead of sampling it once.
	await page.waitForFunction(() => document.querySelectorAll("#task-list li").length === 0);
	await page.locator("details.tool summary").first().click();
	await page.waitForTimeout(350);
	assert.equal(await page.locator("details.tool[open]").count(), 1);
	await page.locator("#shortcut-neon").click();
	await page.waitForFunction(() => document.documentElement.dataset.theme === "neon");
	assert.equal(await page.locator("details.tool[open]").count(), 1, "Theme switches must preserve expanded tool details");
	await page.locator("#shortcut-night").click();
	await page.waitForFunction(() => document.documentElement.dataset.theme === "night");
	await page.locator("#prompt").fill("markup"); await page.locator("#send").click();
	await page.waitForFunction(() => document.getElementById("conversation")!.textContent!.includes("<img"));
	assert.equal(await page.locator("#conversation img").count(), 0);
	await page.locator("#prompt").fill("markdown"); await page.locator("#send").click();
	await page.waitForFunction(() => document.querySelector(".message.assistant .markdown table td.align-right")?.textContent === "135.2");
	const reply = page.locator(".message.assistant .markdown").last();
	assert.equal(await reply.locator("h5").innerText(), "周度小结");
	assert.equal(await reply.locator("ul > li").count(), 2, "Markdown lists render as list items");
	assert.equal(await reply.locator("pre code").innerText(), "const a = 1 < 2;");
	assert.equal(await reply.locator("strong").innerText(), "加粗");
	assert.match(await reply.locator("p").first().innerText(), /^第一行\n第二行/, "A single line break inside a paragraph is kept");
	assert.equal(await reply.locator("a, img, script").count(), 0, "No links, images or scripts are created from model text");
	assert.equal(await reply.locator(".link").getAttribute("title"), "https://example.com/docs");
	assert.match(await reply.innerText(), /<img src=x onerror="alert\(1\)">/, "Raw HTML stays literal text");
	await page.locator(".message.assistant").last().hover();
	await page.waitForTimeout(300);
	await page.locator(".message.assistant").last().screenshot({ path: join(tmpdir(), "tilldone-desk-markdown.png") });
	assert.equal(await page.locator(".message.user button.copy").count(), 0, "Only assistant replies offer a copy button");
	// The smoke runs on a real desktop: put the user's clipboard back afterwards.
	const savedClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
	try {
		const copy = page.locator(".message.assistant").last().locator("button.copy");
		assert.equal(await copy.getAttribute("aria-label"), "Copy Markdown");
		await copy.click();
		await page.waitForFunction(() => document.querySelectorAll(".message.assistant button.copy.copied").length === 1);
		assert.equal(await copy.getAttribute("aria-label"), "Copied");
		const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
		assert.match(copied, /^## 周度小结\n\n第一行\n第二行，\*\*加粗\*\* 和 `inline`/, "The clipboard gets the Markdown source, not the rendered text");
		await page.waitForTimeout(300);
		// Captured by the main process: Playwright's own screenshot blurs the button, which resets the mark.
		const box = (await copy.boundingBox())!;
		const png = await application.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect)).toPNG().toString("base64"),
			{ x: Math.round(box.x - 8), y: Math.round(box.y - 8), width: Math.round(box.width + 16), height: Math.round(box.height + 16) });
		await writeFile(join(tmpdir(), "tilldone-desk-copied.png"), Buffer.from(png, "base64"));
		await page.locator("#prompt").hover();
		await page.waitForFunction(() => document.querySelectorAll("button.copy.copied").length === 0);
	} finally { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard); }
	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	const paste = () => page.evaluate((png) => {
		const file = new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" });
		const data = new DataTransfer(); data.items.add(file);
		document.getElementById("prompt")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	}, PNG);
	await paste(); await paste();
	await page.waitForFunction(() => document.querySelectorAll("#attachments img").length === 2);
	console.log("Smoke: images pasted");
	await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>("#attachments img")).every((img) => img.complete && img.naturalWidth > 0));
	console.log("Smoke: thumbnails loaded");
	await page.locator("#composer").screenshot({ path: join(tmpdir(), "tilldone-desk-paste.png") });
	await page.locator("#attachments button").first().click();
	assert.equal(await page.locator("#attachments img").count(), 1, "The remove button drops one pasted image");
	await page.locator("#prompt").fill("what is this");
	await page.locator("#send").click();
	await page.waitForFunction(() => document.getElementById("conversation")!.textContent!.includes("×1"));
	assert.equal(await page.locator("#attachments").isHidden(), true, "Sending clears the pasted images");
	assert.equal(await page.locator("#conversation img").count(), 0, "The conversation shows an image chip, not image markup");
	await page.locator("#prompt").fill("tasks"); await page.locator("#send").click();
	await page.waitForFunction(() => document.querySelectorAll("#task-list li").length === 2);
	assert.equal(await page.locator("#task-list li button.split").count(), 1, "Only the unfinished task offers a split button");
	await page.waitForFunction(() => document.querySelector("#task-list li .tool-calls")?.textContent?.startsWith("16 "));
	assert.equal(await page.locator("#task-list li .tool-calls").count(), 1, "Only the task that was in progress shows a tool-call count");
	assert.equal(await page.locator("#task-list li .tool-calls").innerText(), "16 tools");
	assert.equal(await page.locator("#task-list li .tool-calls.heavy").count(), 1, "A count past the split hint threshold is emphasized");
	assert.equal(await page.locator("#task-list li .model-calls").innerText(), "16 llms", "Each turn counts as one model call against the task in progress");
	await page.locator("aside").screenshot({ path: join(tmpdir(), "tilldone-desk-split.png") });
	await page.locator("#prompt").fill("busy"); await page.locator("#send").click();
	await page.waitForFunction(() => !(document.querySelector("#stop") as HTMLButtonElement).disabled);
	assert.equal(await page.locator("#mode").count(), 0, "No delivery picker: messages sent while running always steer");
	const split = page.locator("#task-list li button.split");
	await split.click();
	await page.waitForFunction(() => (document.querySelector("#task-list li button.split") as HTMLButtonElement).disabled);
	await split.click({ force: true });
	assert.match(await split.innerText(), /Splitting/);
	await page.locator("#prompt").fill("redirect"); await page.locator("#send").click();
	await page.waitForFunction(() => document.querySelectorAll("#queued li").length === 2);
	assert.match(await page.locator("#queued").innerText(), /Waiting · redirect/);
	await page.locator("#composer").screenshot({ path: join(tmpdir(), "tilldone-desk-queued.png") });
	await page.locator("#stop").click();
	await page.waitForFunction(() => document.getElementById("queued")!.hidden && !(document.querySelector("#task-list li button.split") as HTMLButtonElement).disabled);
	await page.locator("#new-session").click();
	await page.locator("#new-session-dialog").waitFor();
	await page.locator("#new-session-cancel").click();
	assert.ok(await page.locator(".message").count() > 0, "Cancelling a new session keeps the conversation");
	await page.locator("#new-session").click();
	await page.locator("#new-session-confirm").click();
	await page.waitForFunction(() => document.querySelectorAll(".message").length === 0 && !(document.querySelector("#send") as HTMLButtonElement).disabled);
	const records = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(records.some((r) => r.message === "/tilldone"), false);
	assert.ok(records.some((r) => r.type === "prompt" && r.message === "what is this" && r.images?.length === 1 && r.images[0].mimeType === "image/png" && r.images[0].data === PNG), "The pasted image reaches Pi");
	const splitMessage = 'Split task #1 "write the guide" into smaller subtasks with tilldone split (id=1), then continue.';
	assert.equal(records.filter((r) => r.message === splitMessage).length, 1, "Repeated clicks on a pending split send one request");
	assert.ok(records.some((r) => r.type === "steer" && r.message === splitMessage), "A split requested while running steers");
	const launches = records.filter((r) => r.type === "launch");
	assert.equal(launches.length, 2, "New session launches a fresh Pi");
	process.kill(launches.at(-1).pid, "SIGKILL");
	await page.locator("#restart").waitFor();
	assert.match(await page.locator("#error").innerText(), /Pi exited/);
	await page.locator("#restart").click();
	await page.waitForFunction(() => !(document.querySelector("#send") as HTMLButtonElement).disabled);
	assert.equal(await page.locator(".message").count(), 0);
	assert.equal(await page.locator("#theme").inputValue(), "night");
	assert.equal(await page.locator("#shortcut-night").getAttribute("aria-pressed"), "true");
	assert.equal(await page.locator("html").getAttribute("lang"), "en");
	await page.locator("#settings-toggle").click();
	await page.locator("#language").selectOption("zh-CN");
	await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
	assert.deepEqual(JSON.parse(await readFile(join(directory, "appearance.json"), "utf8")), { theme: "night", language: "zh-CN" });
	assert.deepEqual(errors, []);
	await page.screenshot({ path: join(tmpdir(), "tilldone-desk-settings.png") });
	await page.keyboard.press("Escape");
	const screenshot = join(tmpdir(), "tilldone-desk-smoke.png");
	await page.screenshot({ path: screenshot });
	await application.close();
	application = await electron.launch(launchOptions);
	const restored = await application.firstWindow();
	await restored.waitForFunction(() => document.documentElement.dataset.theme === "night");
	assert.equal(await restored.locator("html").getAttribute("lang"), "zh-CN");
	assert.equal(await restored.locator("#shortcut-night").getAttribute("aria-pressed"), "true");
	assert.equal(await restored.locator("#shortcut-label-night").innerText(), "星夜");
	assert.equal(await restored.title(), "边牧任务桌面");
	assert.equal(await restored.locator("#brand-slogan").innerText(), "羊不进圈，边牧不歇");
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 700));
	for (const theme of ["paper", "night", "ink", "neon"]) {
		await restored.locator(`#shortcut-${theme}`).click();
		await restored.waitForFunction((id) => document.documentElement.dataset.theme === id, theme);
		assert.equal(await restored.evaluate(() => {
			const brand = document.querySelector(".brand")!.getBoundingClientRect();
			const actions = document.querySelector(".header-actions")!.getBoundingClientRect();
			const name = document.getElementById("product-name")!;
			const slogan = document.getElementById("brand-slogan")!;
			const range = document.createRange(); range.selectNodeContents(slogan);
			return brand.right <= actions.left && range.getBoundingClientRect().right <= actions.left
				&& name.scrollWidth <= name.clientWidth && document.documentElement.scrollWidth <= innerWidth;
		}), true, `${theme}: Chinese branding must fit without overlapping shortcuts at minimum width`);
		await restored.locator("#settings-toggle").click();
		const toggle = await restored.locator("#settings-toggle").boundingBox();
		const panel = await restored.locator("#settings-panel").boundingBox();
		assert.ok(toggle && panel && panel.y >= toggle.y + toggle.height, "Popover must follow the resized header");
		await restored.keyboard.press("Escape");
		await restored.waitForTimeout(350);
		await restored.screenshot({ path: join(tmpdir(), `tilldone-brand-zh-${theme}.png`) });
	}
	console.log(`Electron smoke passed (fake Pi), including skin persistence across app restart. Screenshot: ${screenshot}`);
} catch (error) {
	const page = await application.firstWindow();
	console.error(await page.locator("body").innerText());
	console.error(await page.evaluate(() => ({ bridge: typeof window.tilldone, script: document.scripts[0]?.src, url: location.href })));
	console.error(await application.evaluate(({ BrowserWindow }) => ({ url: BrowserWindow.getAllWindows()[0].webContents.getURL() })));
	console.error(await readFile(log, "utf8").catch(String));
	console.error("UI smoke failed:", error);
	await page.screenshot({ path: join(tmpdir(), "tilldone-desk-failure.png") });
	throw error;
} finally {
	await application.close();
	await rm(directory, { recursive: true, force: true });
}
