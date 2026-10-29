const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "five-smoke-"));
  let application;
  try {
    application = await electron.launch({
      args: [path.resolve(__dirname, ".."), `--user-data-dir=${userData}`],
    });
    const page = await application.firstWindow();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.addInitScript(() => {
      window.__audioNotes = 0;
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (...args) {
        window.__audioNotes++;
        return start.apply(this, args);
      };
    });
    await page.reload();
    await page.waitForSelector("#board");
    assert.equal(await page.title(), "拾伍 · 五子棋");
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(await page.evaluate(() => typeof window.process), "undefined");
    assert.equal(await page.locator("#undo").isDisabled(), true);
    assert.match(await page.locator("#status-title").innerText(), /轮到你/);

    // Local synthesized music actually schedules audible sources, independently of SFX.
    await page.locator("#sound").click();
    await page.locator("#music-mode").selectOption("piano");
    await page.waitForFunction(() =>
      document.querySelector("#music-status").textContent.includes("正在播放"),
    );
    await page.waitForFunction(() => window.__audioNotes > 0);
    const pianoNotes = await page.evaluate(() => window.__audioNotes);
    await page.locator("#music-volume").fill("18");
    assert.equal(await page.locator("#volume-label").innerText(), "18%");
    await page.locator("#music-mode").selectOption("jazz");
    await page.waitForFunction(
      (count) => window.__audioNotes > count,
      pianoNotes,
    );
    assert.match(await page.locator("#music-status").innerText(), /慢爵士/);
    await page.locator("#music-mode").selectOption("off");
    await page.waitForTimeout(500);
    const stoppedNotes = await page.evaluate(() => window.__audioNotes);
    await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(() => window.__audioNotes), stoppedNotes);

    // Mouse move + real module worker reply.
    const box = await page.locator("#board").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() =>
      document.querySelector("#move-count").textContent.includes("02"),
    );
    assert.match(await page.locator("#status-title").innerText(), /轮到你/);
    assert.equal(await page.locator("#undo").isEnabled(), true);
    assert.equal(
      await page.locator("#toast").isVisible(),
      false,
      "worker should succeed without fallback",
    );
    await page.locator("#numbers").check();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("five.game.v1")),
    );
    assert.equal(saved.moves.length, 2);
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#move-count").textContent.includes("02"),
    );
    assert.equal(await page.locator("#numbers").isChecked(), true);
    assert.equal(await page.locator("#music-volume").inputValue(), "18");
    assert.deepEqual(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("five.game.v1")),
      ),
      saved,
    );

    // Cancelled reset preserves the game; round undo removes both player and AI.
    await page.locator("#new-game").click();
    await page.locator("#confirm-dialog").waitFor({ state: "visible" });
    await page.locator("#cancel-reset").click();
    assert.match(await page.locator("#move-count").innerText(), /02/);
    await page.locator("#undo").click();
    assert.match(await page.locator("#move-count").innerText(), /00/);

    // Undo during search cancels the worker; no stale AI reply can land later.
    await page.locator('[data-level="hard"]').click();
    await page.locator("#board").focus();
    await page.keyboard.press("Enter");
    await page.locator("#undo").click();
    await page.waitForTimeout(1800);
    assert.match(await page.locator("#move-count").innerText(), /00/);

    // New game during search cancels both worker and its delayed response.
    await page.locator("#board").focus();
    await page.keyboard.press("Enter");
    await page.locator("#new-game").click();
    await page.locator("#confirm-reset").click();
    await page.waitForTimeout(1800);
    assert.match(await page.locator("#move-count").innerText(), /00/);

    // All three levels and playing white (AI must open at the center).
    for (const level of ["easy", "medium", "hard"]) {
      await page.locator(`[data-level="${level}"]`).click();
      assert.equal(
        await page
          .locator(`[data-level="${level}"]`)
          .getAttribute("aria-pressed"),
        "true",
      );
    }
    await page.locator('[data-color="2"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#move-count").textContent.includes("01"),
    );
    assert.equal(await page.locator("#undo").isDisabled(), true);
    const whiteGame = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("five.game.v1")),
    );
    assert.deepEqual(whiteGame.moves, [{ row: 7, col: 7, color: 1 }]);
    await page.locator("#board").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("#move-count").textContent.includes("03"),
    );
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    assert.match(await page.locator("#move-count").innerText(), /01/);

    // Seed after the old page's pagehide save, before the new renderer loads.
    await page.addInitScript(() => {
      const moves = [];
      for (let i = 0; i < 5; i++) {
        moves.push({ row: 7, col: 4 + i, color: 1 });
        if (i < 4) moves.push({ row: 9, col: 4 + i, color: 2 });
      }
      localStorage.setItem(
        "five.game.v1",
        JSON.stringify({ humanColor: 1, level: "medium", moves }),
      );
    });
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#status-title").textContent.includes("你赢了"),
    );
    await page.locator("#undo").click();
    assert.match(await page.locator("#move-count").innerText(), /08/);
    assert.match(await page.locator("#status-title").innerText(), /轮到你/);

    await page.locator("#music-mode").selectOption("piano");
    await page.locator("#music-mode").click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() =>
      document.querySelector("#music-status").textContent.includes("正在播放"),
    );
    // Readable minimum window size, without horizontal scrolling.
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(880, 720),
    );
    await page.waitForTimeout(200);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1180, 880),
    );
    await page.waitForTimeout(250);
    const screenshot = path.join(os.tmpdir(), "five-desktop-smoke.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    const layout = await page.evaluate(() => ({
      viewport: innerHeight,
      content: document.documentElement.scrollHeight,
      canvas: document.querySelector("#board").getBoundingClientRect().width,
    }));
    await page.reload();
    await page.waitForSelector("#music-mode");
    assert.equal(await page.locator("#music-mode").inputValue(), "piano");
    assert.equal(await page.locator("#music-volume").inputValue(), "18");
    await page.locator("#sound").click();
    await page.waitForFunction(() =>
      document.querySelector("#music-status").textContent.includes("正在播放"),
    );
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    console.log(
      `Electron smoke passed: AI, undo, restore, music, settings. Layout: ${JSON.stringify(layout)}. Screenshot: ${screenshot}`,
    );
  } finally {
    if (application) await application.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
