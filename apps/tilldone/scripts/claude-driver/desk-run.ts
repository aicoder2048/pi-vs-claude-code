/**
 * Drive the real TillDone Desk (Pi + tilldone + pstack Poteto Mode) through one long task, for Claude Code.
 * Generalised from desk-blackjack-run.ts / desk-blackjack-fix-run.ts (the Blackjack build, 2026-11-01).
 *
 * Usage (from apps/tilldone):
 *   bun scripts/claude-driver/desk-run.ts --work <project dir> --prompt <prompt.md> --out <dir> [--name run] [--max-min 150] [--model openai-codex/gpt-6.1-sol]
 *
 * - Launches this app with TILLDONE_PSTACK=1 and TILLDONE_CWD=<work>; the project must have pstack installed
 *   (`pi install npm:pi-pstack -l`).
 * - Pastes the whole prompt file and sends it. Start the prompt with `/skill:poteto-mode` (the desk passes it through as-is).
 * - Every 15 s: auto-denies confirm dialogs, cancels ask dialogs (select/input/editor), logs task-list changes, stops on alert.
 * - Treats the run as settled after 20 s idle; hard limit --max-min minutes.
 * - Writes <out>/<name>.log, <name>.png (screenshot), <name>-conversation.txt, <name>-tasks.txt.
 */
import { _electron as electron } from "@playwright/test";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
	const i = argv.indexOf(`--${name}`);
	const value = i >= 0 ? argv[i + 1] : fallback;
	if (value === undefined) throw new Error(`missing --${name}`);
	return value;
};
const app = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = resolve(arg("work"));
const promptFile = resolve(arg("prompt"));
const out = resolve(arg("out"));
const name = arg("name", "run");
const maxMinutes = Number(arg("max-min", "150"));
const model = arg("model", "openai-codex/gpt-6.1-sol");
if (model.startsWith("anthropic/")) throw new Error("anthropic/* models are not allowed (pay-per-use API).");

await mkdir(out, { recursive: true });
const logFile = join(out, `${name}.log`);
await writeFile(logFile, "");
const log = (s: string) => {
	const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
	console.log(line);
	return appendFile(logFile, line + "\n");
};

const prompt = await readFile(promptFile, "utf8");
const userData = await mkdtemp(join(out, `${name}-userdata-`));
await log(`app=${app} work=${work} prompt=${promptFile} (${prompt.length} chars) model=${model}`);
const application = await electron.launch({
	executablePath: join(app, "node_modules/.bin/electron"),
	args: [app, `--user-data-dir=${userData}`],
	cwd: app,
	env: { ...process.env, TILLDONE_PSTACK: "1", TILLDONE_CWD: work, TILLDONE_MODEL: model },
});
const deadline = Date.now() + maxMinutes * 60_000;
try {
	const page = await application.firstWindow();
	page.on("pageerror", (e) => void log("PAGE ERROR " + e.message));
	await page.waitForFunction(() => !(document.querySelector("#send") as HTMLButtonElement).disabled, null, { timeout: 90_000 });
	await log("connected: " + (await page.locator("footer").innerText()).replace(/\n/g, " | "));
	await page.locator("#prompt").fill(prompt);
	await page.locator("#send").click();
	await page.waitForFunction(
		() => !(document.querySelector("#stop") as HTMLButtonElement).disabled || !(document.querySelector("#alert") as HTMLElement).hidden,
		null,
		{ timeout: 90_000 },
	);
	if (await page.locator("#alert").isVisible()) throw new Error("Desk alert after send: " + (await page.locator("#alert").innerText()));
	await log("running");
	let idleSince = 0;
	let lastTasks = "";
	while (Date.now() < deadline) {
		await page.waitForTimeout(15_000);
		if (await page.locator("#confirm-dialog").evaluate((d: HTMLDialogElement) => d.open)) {
			await log(`CONFIRM DENIED: ${await page.locator("#confirm-title").innerText()} — ${await page.locator("#confirm-message").innerText()}`);
			await page.locator("#deny").click();
		}
		if (await page.locator("#ask-dialog").evaluate((d: HTMLDialogElement) => d.open)) {
			await log(`ASK CANCELLED: ${await page.locator("#ask-title").innerText()}`);
			await page.locator("#ask-cancel").click();
		}
		const tasks = (await page.locator("#tasks").innerText()).replace(/\n+/g, " | ");
		if (tasks !== lastTasks) {
			await log("tasks: " + tasks.slice(0, 1200));
			lastTasks = tasks;
		}
		const running = !(await page.locator("#stop").isDisabled());
		if (await page.locator("#alert").isVisible()) {
			await log("ALERT: " + (await page.locator("#alert").innerText()));
			break;
		}
		if (running) idleSince = 0;
		else if (!idleSince) idleSince = Date.now();
		else if (Date.now() - idleSince > 20_000) {
			await log("idle — run settled");
			break;
		}
	}
	if (Date.now() >= deadline) await log("DEADLINE reached");
	await page.screenshot({ path: join(out, `${name}.png`) });
	const conversation = await page.locator("#conversation").innerText();
	await writeFile(join(out, `${name}-conversation.txt`), conversation);
	await writeFile(join(out, `${name}-tasks.txt`), await page.locator("#tasks").innerText());
	await log("=== final assistant tail ===\n" + conversation.slice(-4000));
	await log("=== diagnostics ===\n" + (await page.locator("#stderr").innerText()).slice(-1500));
} finally {
	await application.close();
}
