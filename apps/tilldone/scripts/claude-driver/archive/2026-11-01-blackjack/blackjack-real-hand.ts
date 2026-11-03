/** Play one real hand of the generated Blackjack app with the real Pi + openai-codex model. Human always stands. */
import { _electron as electron } from "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/node_modules/@playwright/test/index.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
const app = "/Users/szou/Python/Playground/DoorBird/Apps/blackjack";
const out = "/private/tmp/claude-501/-Users-szou-Python-Playground-DoorBird-Apps-tilldone/9ebd017c-93db-40bc-8b07-f903e64a63cb/scratchpad";
const userData = await mkdtemp(join(out, "bj-userdata-"));
const application = await electron.launch({ executablePath: join(app, "node_modules/.bin/electron"), args: [app, `--user-data-dir=${userData}`], cwd: app, env: { ...process.env } });
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
try {
	const page = await application.firstWindow();
	page.on("pageerror", (e) => log("PAGE ERROR " + e.message));
	await page.locator("#bet").waitFor();
	log("model: " + await page.locator("#model").innerText());
	await page.locator("#bet-amount").fill("25");
	await page.locator("#bet").click();
	let lastStatus = "";
	while (Date.now() - t0 < 6 * 60_000) {
		await page.waitForTimeout(1500);
		const status = `${await page.locator("#status").innerText()} | ${await page.locator("#status-detail").innerText()} | agent=${await page.locator("#agent-state").innerText()}`;
		if (status !== lastStatus) { log(status); lastStatus = status; }
		const err = await page.locator("#error").innerText();
		if (err.trim()) log("ERROR: " + err);
		if (await page.locator("#retry").isVisible()) { log("AI failed (retry shown)"); break; }
		if (await page.locator("#next").isVisible()) { log("hand finished"); break; }
		if (await page.locator("#play-controls").isVisible() && (await page.locator("#human-turn").innerText()).trim()) {
			const stand = page.locator("#stand");
			if (await stand.isEnabled()) { log("human: stand"); await stand.click(); }
		}
	}
	await page.screenshot({ path: join(out, "blackjack-real-hand.png") });
	log("reason: " + await page.locator("#reason").innerText());
	log("dealer: " + await page.locator("#dealer-cards").innerText().catch(() => "") + " " + await page.locator("#dealer-score").innerText());
	log("ai hands: " + (await page.locator("#ai-hands").innerText()).replace(/\n/g, " ") + " | bankroll " + await page.locator("#ai-bankroll").innerText());
	log("traces:\n" + (await page.locator("#traces").innerText()).slice(0, 2500));
} finally { await application.close(); }
