/** Drive real TillDone Desk (TILLDONE_PSTACK=1, cwd=blackjack) through a long build task. Auto-denies pstack confirmations. */
import { _electron as electron } from "/Users/szou/Python/Playground/DoorBird/Apps/tilldone/node_modules/@playwright/test/index.js";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
const app = "/Users/szou/Python/Playground/DoorBird/Apps/tilldone";
const work = "/Users/szou/Python/Playground/DoorBird/Apps/blackjack";
const out = "/private/tmp/claude-501/-Users-szou-Python-Playground-DoorBird-Apps-tilldone/9ebd017c-93db-40bc-8b07-f903e64a63cb/scratchpad";
const progress = join(out, process.argv[3] ?? "blackjack-progress.log");
const log = (s: string) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); return appendFile(progress, line + "\n"); };
await writeFile(progress, "");
const prompt = await readFile(join(out, process.argv[2] ?? "blackjack-prompt.md"), "utf8");
const userData = await mkdtemp(join(out, "desk-userdata-"));
const application = await electron.launch({
	executablePath: join(app, "node_modules/.bin/electron"),
	args: [app, `--user-data-dir=${userData}`],
	cwd: app,
	env: { ...process.env, TILLDONE_PSTACK: "1", TILLDONE_CWD: work, TILLDONE_MODEL: "openai-codex/gpt-6.1-sol" },
});
const deadline = Date.now() + 150 * 60_000;
try {
	const page = await application.firstWindow();
	page.on("pageerror", (e) => void log("PAGE ERROR " + e.message));
	await page.waitForFunction(() => !(document.querySelector("#send") as HTMLButtonElement).disabled, null, { timeout: 60000 });
	await log("connected: " + (await page.locator("footer").innerText()).replace(/\n/g, " | "));
	await page.locator("#prompt").fill(prompt);
	await page.locator("#send").click();
	await page.waitForFunction(() => !(document.querySelector("#stop") as HTMLButtonElement).disabled || !(document.querySelector("#alert") as HTMLElement).hidden, null, { timeout: 60000 });
	if (await page.locator("#alert").isVisible()) throw new Error("Desk alert after send: " + await page.locator("#alert").innerText());
	await log("running");
	let idleSince = 0, lastTasks = "";
	while (Date.now() < deadline) {
		await page.waitForTimeout(15000);
		if (await page.locator("#confirm-dialog").evaluate((d: HTMLDialogElement) => d.open)) {
			await log(`CONFIRM DENIED: ${await page.locator("#confirm-title").innerText()} — ${await page.locator("#confirm-message").innerText()}`);
			await page.locator("#deny").click();
		}
		const tasks = (await page.locator("#tasks").innerText()).replace(/\n+/g, " | ");
		if (tasks !== lastTasks) { await log("tasks: " + tasks.slice(0, 900)); lastTasks = tasks; }
		const running = !(await page.locator("#stop").isDisabled());
		const alert = await page.locator("#alert").isVisible();
		if (alert) { await log("ALERT: " + await page.locator("#alert").innerText()); break; }
		if (running) idleSince = 0;
		else if (!idleSince) idleSince = Date.now();
		else if (Date.now() - idleSince > 20000) { await log("idle — run settled"); break; }
	}
	if (Date.now() >= deadline) await log("DEADLINE reached");
	await page.screenshot({ path: join(out, "desk-blackjack-fix.png") });
	await writeFile(join(out, "desk-blackjack-conversation.txt"), await page.locator("#conversation").innerText());
	await log("=== final assistant tail ===\n" + (await page.locator("#conversation").innerText()).slice(-4000));
	await log("=== diagnostics ===\n" + (await page.locator("#stderr").innerText()).slice(-1500));
} finally {
	await application.close();
}
