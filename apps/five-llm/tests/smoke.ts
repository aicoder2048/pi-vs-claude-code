import { _electron as electron, expect } from 'playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const electronApp = await electron.launch({ args: ['.'], env: { ...process.env, FIVE_LLM_SMOKE: '1' }, timeout: 30000 });
let dataDir = '';
try {
  dataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  const page = await electronApp.firstWindow();
  const errors: string[] = [], remoteMedia: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'media' && /^https?:/.test(request.url())) remoteMedia.push(request.url()); });
  await expect(page.locator('#model')).toContainText('fixture');
  await expect(page.locator('#status-title')).toHaveText('从天元开始，也很好');
  await expect(page.locator('#match-format')).toHaveText('三局两胜');
  await expect(page.locator('#last-move')).not.toContainText('最近落子');
  async function expectLatestMove(owner: '你' | 'LLM', ply: number): Promise<void> {
    const label = await page.locator('#moves button').nth(ply - 1).getAttribute('aria-label');
    const coord = label!.match(/([A-O]\d+)$/)![1];
    await expect(page.locator('#last-move')).toHaveText(`青色光晕 · 最近落子：${owner} · ${ply % 2 ? '黑' : '白'} ${coord} · 第 ${ply} 手`);
    await expect(page.locator('#board')).toHaveAttribute('aria-label', new RegExp(`最近落子：${owner}`));
    // Verify the rendered cyan ring itself, not just its descriptive caption.
    const pixel = await page.locator('#board').evaluate((element: HTMLCanvasElement, coord) => {
      const step = (760 - 104) / 14, scale = element.width / 760;
      const x = 52 + (coord.charCodeAt(0) - 65) * step + step * .448 + 3;
      const y = 52 + (15 - Number(coord.slice(1))) * step;
      return Array.from(element.getContext('2d')!.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    }, coord);
    expect(pixel[1] - pixel[0]).toBeGreaterThan(35);
    expect(pixel[2] - pixel[0]).toBeGreaterThan(35);
  }
  // Enable the existing practice undo flow explicitly; competition defaults to no undo.
  await page.locator('#new-game').click(); await page.locator('#allow-undo').check();
  await page.locator('button[value=start]').click();
  await expect(page.locator('#new-dialog')).not.toBeVisible();
  const bounds = await page.locator('#board').boundingBox();
  if (!bounds) throw new Error('Missing board');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.locator('#record-count')).toHaveText('2 MOVES');
  await expect(page.locator('#status-badge')).toHaveText('轮到你了');
  await expect(page.locator('#reason-text')).toContainText('自动化测试');
  await expectLatestMove('LLM', 2);
  await page.locator('#board').screenshot({ path: 'artifacts/last-move-llm.png' });
  await page.locator('#numbers').click();
  await expectLatestMove('LLM', 2); // Highlight must not depend on move numbers.
  await page.locator('#numbers').click();
  // Replay cannot add a move; returning live restores the authoritative board.
  await page.locator('#moves button').first().click();
  await expect(page.locator('#status-badge')).toHaveText('棋谱回看');
  await expectLatestMove('你', 1);
  await page.locator('#board').screenshot({ path: 'artifacts/last-move-human.png' });
  await page.locator('#board').press('ArrowRight'); await page.locator('#board').press('Enter');
  await expect(page.locator('#record-count')).toHaveText('2 MOVES');
  await page.locator('#replay').fill('0');
  await expect(page.locator('#last-move')).not.toContainText('最近落子');
  await page.locator('#live').click();
  await expectLatestMove('LLM', 2);
  await page.locator('#hints').click();
  const music = page.locator('#background-music');
  await page.locator('#music').click(); await expect(page.locator('#music')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => music.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(150);
  await expect.poll(() => music.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(.1);
  expect(await music.evaluate((element: HTMLAudioElement) => element.currentSrc)).toContain('gymnopedie-no-1.mp3');
  await page.locator('#music-style').selectOption('jazz');
  await expect.poll(() => music.evaluate((element: HTMLAudioElement) => element.currentSrc.endsWith('night-on-the-docks-sax.mp3') && !element.paused && Number.isFinite(element.duration) && element.duration > 150)).toBe(true);
  expect(await music.evaluate((element: HTMLAudioElement) => element.currentSrc)).toContain('night-on-the-docks-sax.mp3');
  await expect.poll(() => music.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(.1);
  await page.locator('#music').click();
  await expect(page.locator('#music')).toHaveAttribute('aria-pressed', 'false');
  expect(await music.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await page.locator('#music-credits').click(); await expect(page.locator('#music-dialog')).toContainText('Kevin MacLeod');
  await expect(page.locator('#music-dialog')).toContainText('creativecommons.org/licenses/by/4.0/');
  await page.locator('#music-dialog button').click(); expect(remoteMedia).toEqual([]);
  await expect(page.locator('#toast')).toBeHidden({ timeout: 6000 });
  // The viewport, not a guessed board width, must contain every major control.
  for (const size of [{ width: 1280, height: 900 }, { width: 1100, height: 760 }, { width: 1010, height: 700 }]) {
    await electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), size);
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      height: innerHeight, width: innerWidth, scroll: document.documentElement.scrollHeight,
      controls: ['board', 'new-game', 'export', 'replay', 'music', 'human-clock', 'machine-clock'].map(id => {
        const r = document.getElementById(id)!.getBoundingClientRect(); return { id, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
      }),
    }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.height + 1);
    for (const control of layout.controls) {
      expect(control.top, control.id).toBeGreaterThanOrEqual(0); expect(control.bottom, control.id).toBeLessThanOrEqual(layout.height);
      expect(control.left, control.id).toBeGreaterThanOrEqual(0); expect(control.right, control.id).toBeLessThanOrEqual(layout.width); expect(control.width).toBeGreaterThan(0);
    }
    await page.screenshot({ path: `artifacts/layout-${size.width}x${size.height}.png` });
  }
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await page.locator('#undo').click(); await expect(page.locator('#record-count')).toHaveText('0 MOVES');
  await expect(page.locator('#last-move')).not.toContainText('最近落子');
  // White human: LLM fixture makes the opening, human is next.
  await page.locator('#new-game').click();
  await page.locator('input[name=color][value="2"]').check();
  await page.locator('button[value=start]').click();
  await expect(page.locator('#record-count')).toHaveText('1 MOVES');
  await expect(page.locator('#human-color')).toHaveText('执白 · 后手');
  await expect(page.locator('#status-badge')).toHaveText('轮到你了');
  await expectLatestMove('LLM', 1); // LLM opening as black receives the same halo.
  await page.screenshot({ path: 'artifacts/white-opening.png', fullPage: true });
  // A round result is distinct from a match result; first to two wins ends BO3.
  await page.locator('#resign').click(); await page.locator('button[value=resign]').click();
  await expect(page.locator('#machine-wins')).toHaveText('1');
  await expect(page.locator('#next-round')).toBeVisible();
  await page.locator('#next-round').click(); await expect(page.locator('#human-color')).toHaveText('执黑 · 先手');
  await page.locator('#resign').click(); await page.locator('button[value=resign]').click();
  await expect(page.locator('#machine-wins')).toHaveText('2'); await expect(page.locator('#status-badge')).toHaveText('比赛结束');
  await expect(page.locator('#next-round')).toBeHidden();
  // BO5 and actual main-process byoyomi timeout (0 main + one 5-second period).
  await page.locator('#new-game').click(); await page.locator('#best-of').selectOption('5');
  await page.locator('#main-minutes').fill('0'); await page.locator('#period-seconds').fill('5'); await page.locator('#period-count').fill('1');
  await page.locator('input[name=color][value="1"]').check(); await page.locator('button[value=start]').click();
  await expect(page.locator('#match-format')).toHaveText('五局三胜');
  await expect(page.locator('#human-clock-phase')).toHaveText('每步读秒');
  // Opening and dismissing settings must neither restart the match nor stop its clock.
  await page.locator('#new-game').click(); await page.keyboard.press('Escape');
  await expect(page.locator('#status-badge')).toHaveText('本局结束', { timeout: 8000 });
  await expect(page.locator('#status-description')).toContainText('最后一次读秒耗尽');
  await expect(page.locator('#machine-wins')).toHaveText('1'); await expect(page.locator('#human-time')).toHaveText('00:00');
  await page.screenshot({ path: 'artifacts/timeout.png' });
  // Electron isolation: no node APIs in renderer; four fixed bridge functions only.
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
  expect(await page.evaluate(() => Object.keys(window.five).sort())).toEqual(['bootstrap', 'command', 'exportRecord', 'onState']);
  expect(errors).toEqual([]);
  const files = await Array.fromAsync(new Bun.Glob('records/*.json').scan(dataDir));
  expect(files.length).toBeGreaterThanOrEqual(2);
  const record = await Bun.file(path.join(dataDir, files.at(-1)!)).json();
  expect(record.format).toBe('five-llm/v1');
  console.log('PASS: Electron + no-scroll + board/replay/undo + clocks/BO3/BO5 + real timeout + offline MP3 decoding/playback/credits + autosave');
} finally {
  await electronApp.close();
  if (dataDir.includes('five-llm-smoke-')) await rm(dataDir, { recursive: true, force: true });
}
