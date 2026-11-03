/** Visible Electron UI: one launch per stacked scenario, real pi + openai-codex. Human (7,10) bets 10 and stands. */
import { _electron as electron } from "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/node_modules/@playwright/test/index.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
const app = "/Users/szou/Python/Playground/DoorBird/Apps/blackjack";
const out = "/private/tmp/claude-501/-Users-szou-Python-Playground-DoorBird-Apps-tilldone/9ebd017c-93db-40bc-8b07-f903e64a63cb/scratchpad";
// order: human1, ai1, up, human2, ai2, hole, next...
const scenarios = [
  { name: "ui-split-88v6", label: "AI 8,8 对庄家 6", stack: "7,8,6,10,8,10,3,10,2,9" },
  { name: "ui-double-11v6", label: "AI 5,6=11 对庄家 6", stack: "7,5,6,10,6,10,9" },
  { name: "ui-double-a7v4", label: "AI A,7=软18 对庄家 4", stack: "7,A,4,10,7,10,2" },
  { name: "ui-pair-1010v6", label: "AI 10,10 对庄家 6", stack: "7,10,6,10,10,10,5" },
];
const only = process.argv[2] ? process.argv[2].split(",").map(Number) : scenarios.map((_, i) => i);
for (const i of only) {
  const s = scenarios[i];
  const userData = await mkdtemp(join(out, "bj-ui-userdata-"));
  const application = await electron.launch({ executablePath: join(app, "node_modules/.bin/electron"), args: [join(out, "emain-bj"), `--user-data-dir=${userData}`], cwd: app,
    env: { ...process.env, BJ_STACK: s.stack } });
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${s.name} ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  console.log(`\n=== ${s.label} ===`);
  try {
    const page = await application.firstWindow();
    await page.locator("#bet").waitFor();
    await page.waitForTimeout(2000);
    await page.locator("#bet-amount").fill("10");
    await page.locator("#bet").click();
    let last = "";
    while (Date.now() - t0 < 8 * 60_000) {
      await page.waitForTimeout(1500);
      const st = `${await page.locator("#status").innerText()} | agent=${await page.locator("#agent-state").innerText()}`;
      if (st !== last) { log(st); last = st; }
      if (await page.locator("#retry").isVisible()) { log("AI failed: " + await page.locator("#error").innerText()); break; }
      if (await page.locator("#next").isVisible()) { log("settled"); break; }
      if (await page.locator("#play-controls").isVisible() && (await page.locator("#human-turn").innerText()).trim() && await page.locator("#stand").isEnabled()) {
        await page.waitForTimeout(1500); log("human: stand"); await page.locator("#stand").click();
      }
    }
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    log("dealer: " + (await page.locator("#dealer-cards").innerText()).replace(/\s+/g, " ") + " = " + await page.locator("#dealer-score").innerText());
    log("ai: " + (await page.locator("#ai-hands").innerText()).replace(/\s+/g, " ") + " | bankroll " + await page.locator("#ai-bankroll").innerText());
    log("reason: " + await page.locator("#reason").innerText());
    log("traces: " + (await page.locator("#traces").innerText()).replace(/\n+/g, " | ").slice(0, 1200));
  } finally { await application.close(); }
}
