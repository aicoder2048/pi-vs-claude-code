import { _electron as electron, expect } from 'playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { HUMAN_MISTAKES } from './fixtures/human-mistakes';
await mkdir('artifacts', { recursive: true });
const application = await electron.launch({ args: ['.'], env: { ...process.env, CHINESE_CHESS_SMOKE: '1' }, timeout: 30000 });
let dataDir = '';
try {
  dataDir = await application.evaluate(({ app }) => app.getPath('userData'));
  const page = await application.firstWindow(), errors: string[] = [], remoteMedia: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.resourceType() === 'media' && /^https?:/.test(r.url())) remoteMedia.push(r.url()); });
  await expect(page.locator('#model')).toContainText('fixture');
  await expect(page.locator('#pieces .piece')).toHaveCount(32);
  await expect(page.locator('#match-format')).toHaveText('三局两胜');
  await expect(page.locator('#status-title')).toHaveText('楚河汉界，落子有声');
  await page.locator('#new-game').click(); await page.locator('#allow-undo').check(); await page.locator('button[value=start]').click();
  await expect(page.locator('#new-dialog')).not.toBeVisible();
  // Select red soldier; exactly one legal dot. Invalid destination must not move it.
  await page.getByRole('button', { name: '红兵 A6', exact: true }).click();
  await expect(page.locator('.legal-dot')).toHaveCount(1);
  const box = await page.locator('#board').boundingBox(); if (!box) throw new Error('Board missing');
  await page.mouse.click(box.x + box.width * .5 / 9, box.y + box.height * 5.5 / 10);
  await expect(page.locator('#record-count')).toHaveText('2 手');
  await expect(page.locator('#status-badge')).toHaveText('轮到你了');
  await expect(page.locator('#reason-text')).toContainText('自动化测试');
  // Fixture chooses a cannon capture from heuristic candidates, exercising capture particles.
  await expect(page.locator('#pieces .piece')).toHaveCount(31);
  await page.screenshot({ path: 'artifacts/capture.png' });
  await expect(page.locator('#red-captured')).toContainText('马');
  // Replay cannot mutate the live game. Rewinding restores the captured piece.
  await page.locator('#moves button').first().click(); await expect(page.locator('#status-badge')).toHaveText('棋谱回看');
  await expect(page.locator('#pieces .piece')).toHaveCount(32);
  await page.locator('#board').press('ArrowRight'); await page.locator('#board').press('Enter');
  await expect(page.locator('#record-count')).toHaveText('2 手');
  await page.locator('#live').click(); await expect(page.locator('#pieces .piece')).toHaveCount(31);
  await page.locator('#flip').click(); await page.locator('#flip').click();
  await page.locator('#animation').click(); await page.locator('#animation').click();
  await page.locator('#layers-toggle').click(); await expect(page.locator('#layers')).toContainText('review_move'); await expect(page.locator('#layers')).toContainText('compare_moves'); await page.locator('#layers-close').click();
  await page.locator('#expert-open').click(); await expect(page.locator('#expert-dialog')).toBeVisible();
  await expect(page.locator('#expert-report')).toContainText('炮架是动态资源');
  await expect(page.locator('#expert-report')).toContainText('最近一次机器提交的独立复查');
  await expect(page.locator('#expert-report')).toContainText('计算边界');
  await page.screenshot({ path: 'artifacts/expert-report.png' }); await page.locator('#expert-close').click();
  // Backfill an independently stored finished game, not the current live board.
  await mkdir(path.join(dataDir, 'records'), { recursive: true });
  await Bun.write(path.join(dataDir, 'records/smoke-learning-game.json'), JSON.stringify({ format: 'chinese-chess/v1', id: 'smoke-learning-game', human: 1, moves: HUMAN_MISTAKES, outcome: { winner: 2, reason: 'resign' }, notes: [{ ply: 46, riskAcknowledgement: 'Explicit fixture sacrifice' }] }));
  await page.locator('#learning-open').click(); await page.locator('#learning-rescan').click();
  await expect(page.locator('#learning-count')).toContainText('案例库：2', { timeout: 15000 });
  await page.locator('#review-select').selectOption('smoke-learning-game'); await page.locator('#review-load').click();
  await expect(page.locator('#review-details')).toContainText('第 31 手');
  await expect(page.locator('#review-details')).toContainText('第 49 手');
  await expect(page.locator('#review-details')).toContainText('候选，不入库');
  await page.screenshot({ path: 'artifacts/learning-loop.png' }); await page.locator('#learning-close').click();
  expect(await page.evaluate(async () => (await window.chess.reviewGame('../../auth')).ok)).toBe(false);
  const music = page.locator('#background-music');
  await page.locator('#music').click(); await expect(page.locator('#music')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => music.evaluate((n: HTMLAudioElement) => n.duration)).toBeGreaterThan(150);
  await expect.poll(() => music.evaluate((n: HTMLAudioElement) => n.currentTime)).toBeGreaterThan(.1);
  await expect(page.locator('#music-style')).toBeEnabled(); await page.locator('#music-style').selectOption('jazz');
  await expect.poll(() => music.evaluate((n: HTMLAudioElement) => n.currentSrc.endsWith('night-on-the-docks-sax.mp3') && !n.paused && n.duration > 150)).toBe(true);
  await expect(page.locator('#music')).toBeEnabled(); await page.locator('#music').click();
  await expect(page.locator('#music')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#music-credits').click(); await expect(page.locator('#music-dialog')).toContainText('Kevin MacLeod');
  await page.locator('#music-close').click(); expect(remoteMedia).toEqual([]);
  await expect(page.locator('#toast')).toBeHidden({ timeout: 6000 });
  for (const size of [{ width: 1280, height: 900 }, { width: 1100, height: 760 }, { width: 1010, height: 700 }]) {
    await application.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s.width, s.height), size); await page.waitForTimeout(180);
    const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollHeight,
      controls: ['board', 'new-game', 'export', 'replay', 'music', 'human-clock', 'machine-clock', 'expert-open', 'learning-open'].map(id => { const r = document.getElementById(id)!.getBoundingClientRect(); return { id, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; }) }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.height + 1);
    for (const r of layout.controls) { expect(r.top, r.id).toBeGreaterThanOrEqual(0); expect(r.bottom, r.id).toBeLessThanOrEqual(layout.height); expect(r.left, r.id).toBeGreaterThanOrEqual(0); expect(r.right, r.id).toBeLessThanOrEqual(layout.width); expect(r.width, r.id).toBeGreaterThan(0); }
    await page.screenshot({ path: `artifacts/layout-${size.width}x${size.height}.png` });
  }
  await page.locator('#undo').click(); await expect(page.locator('#record-count')).toHaveText('0 手'); await expect(page.locator('#pieces .piece')).toHaveCount(32);
  // Keyboard: red center soldier at E6 selected with Enter, moved with Up + Enter.
  await page.locator('#board').focus(); await page.locator('#board').press('Escape'); await page.locator('#board').press('Enter');
  await expect(page.locator('.piece.selected')).toHaveAttribute('aria-label', '红兵 E6');
  await page.locator('#board').press('ArrowUp');
  await expect(page.locator('.piece.selected')).toHaveAttribute('aria-label', '红兵 E6');
  await page.locator('#board').press('Enter');
  await expect(page.locator('#record-count')).toHaveText('2 手');
  // Black human: LLM opens, auto-orientation and color are changed.
  await page.locator('#new-game').click(); await page.locator('input[name=color][value="2"]').check(); await page.locator('button[value=start]').click();
  await expect(page.locator('#record-count')).toHaveText('1 手'); await expect(page.locator('#human-color')).toHaveText('执黑 · 后手');
  await expect(page.locator('#status-badge')).toHaveText('轮到你了');
  await page.screenshot({ path: 'artifacts/black-opening.png' });
  // Human black pieces are at the visual bottom; click maps back to business coordinates.
  await page.getByRole('button', { name: '黑卒 A3', exact: true }).click();
  await expect(page.locator('.legal-dot')).toHaveCount(1);
  const flipped = await page.locator('#board').boundingBox(); if (!flipped) throw new Error('Missing flipped board');
  await page.mouse.click(flipped.x + flipped.width * 8.5 / 9, flipped.y + flipped.height * 5.5 / 10);
  await expect(page.locator('#record-count')).toHaveText('3 手');
  for (let i = 0; i < 2; i++) {
    await page.locator('#resign').click(); await page.locator('#confirm-yes').click(); await expect(page.locator('#machine-wins')).toHaveText(String(i + 1));
    if (!i) { await page.locator('#next-round').click(); await expect(page.locator('#human-color')).toHaveText('执红 · 先手'); }
  }
  await expect(page.locator('#status-badge')).toHaveText('比赛结束'); await expect(page.locator('#next-round')).toBeHidden();
  // Real main-process timeout while settings stay open. Opening/canceling is not a pause.
  await page.locator('#new-game').click(); await page.locator('#best-of').selectOption('5'); await page.locator('#time-control').selectOption('absolute');
  await page.locator('#main-minutes').fill('0.05'); await page.locator('input[name=color][value="1"]').check(); await page.locator('button[value=start]').click();
  await expect(page.locator('#match-format')).toHaveText('五局三胜'); await page.locator('#new-game').click();
  await expect(page.locator('#status-badge')).toHaveText('本局结束', { timeout: 8000 }); await page.keyboard.press('Escape');
  await expect(page.locator('#human-time')).toHaveText('00:00'); await expect(page.locator('#status-description')).toContainText('棋钟耗尽');
  await page.screenshot({ path: 'artifacts/timeout.png' });
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
  expect(await page.evaluate(() => Object.keys(window.chess).sort())).toEqual(['bootstrap', 'command', 'evaluation', 'exportRecord', 'onLearning', 'onState', 'rescanLearning', 'reviewGame']);
  expect(errors).toEqual([]);
  const files = await Array.fromAsync(new Bun.Glob('records/*.json').scan(dataDir)); expect(files.length).toBeGreaterThanOrEqual(3);
  const records = await Promise.all(files.map(f => Bun.file(path.join(dataDir, f)).json()));
  expect(records.every(r => r.format === 'chinese-chess/v1')).toBe(true);
  const library = await Bun.file(path.join(dataDir, 'learning/library.json')).json();
  expect(library.cases).toHaveLength(2); expect(library.reviews.some((r: any) => r.gameId === 'smoke-learning-game')).toBe(true);
  expect(records.some(r => r.notes.some((n: any) => n.review?.coverage))).toBe(true);
  expect(records.some(r => r.evaluations?.some((a: any) => a.expert?.version === 'xiangqi-expert/v1'))).toBe(true);
  console.log('PASS: real Electron + 32-piece board / capture / keyboard / replay / undo + no-scroll 900/760/700 + BO3/BO5 + clocks/timeout + offline music decoding + isolated IPC + autosave');
} finally { await application.close(); if (dataDir.includes('chinese-chess-smoke-')) await rm(dataDir, { recursive: true, force: true }); }
