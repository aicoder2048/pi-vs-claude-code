/** Real Electron + real Pi (openai-codex) with TILLDONE_PSTACK=1: run a pstack arena subagent from the desk UI. */
import { _electron as electron } from "/Users/szou/Python/Playground/DoorBird/Apps/tilldone/node_modules/@playwright/test/index.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
const app = "/Users/szou/Python/Playground/DoorBird/Apps/tilldone";
const out = "/private/tmp/claude-501/-Users-szou-Python-Playground-DoorBird-Apps-tilldone/9ebd017c-93db-40bc-8b07-f903e64a63cb/scratchpad";
const userData = await mkdtemp(join(out, "desk-userdata-"));
const application = await electron.launch({
	executablePath: join(app, "node_modules/.bin/electron"),
	args: [app, `--user-data-dir=${userData}`],
	cwd: app,
	env: { ...process.env, TILLDONE_PSTACK: "1", TILLDONE_CWD: app, TILLDONE_MODEL: "openai-codex/gpt-6-luna" },
});
try {
	const page = await application.firstWindow();
	page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
	await page.waitForFunction(() => !(document.querySelector("#send") as HTMLButtonElement).disabled, null, { timeout: 30000 });
	console.log("connected; footer:", await page.locator("footer").innerText());
	await page.locator("#prompt").fill('Call the subagent tool exactly once with the tasks parameter (parallel): two tasks, both agent poteto-agent and role "arena runners". Task A: reply with only ALPHA. Task B: reply with only BRAVO. No tools besides reading your required skill. Then report both replies verbatim and which model each subagent used.');
	await page.locator("#send").click();
	await page.waitForFunction(() => !(document.querySelector("#stop") as HTMLButtonElement).disabled, null, { timeout: 30000 });
	console.log("running…");
	await page.waitForFunction(() => (document.querySelector("#stop") as HTMLButtonElement).disabled, null, { timeout: 300000 });
	await page.waitForTimeout(1000);
	await page.screenshot({ path: join(out, "desk-pstack-e2e.png") });
	console.log("=== conversation ===\n" + (await page.locator("#conversation").innerText()).slice(-3000));
	console.log("=== tasks ===\n" + await page.locator("#tasks").innerText());
	console.log("=== diagnostics ===\n" + (await page.locator("#stderr").innerText()).slice(-1500));
} finally {
	await application.close();
}
