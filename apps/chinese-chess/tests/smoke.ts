import { _electron as electron, expect } from 'playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { HUMAN_MISTAKES } from './fixtures/human-mistakes';
import type { GameState } from '../src/shared/types';
await mkdir('artifacts', { recursive: true });
// CHINESE_CHESS_APP points at a packaged executable to smoke-test the release build.
const packaged = process.env.CHINESE_CHESS_APP;
const application = await electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }), env: { ...process.env, CHINESE_CHESS_SMOKE: '1' }, timeout: 30000 });
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
  await expect(page.locator('#machine-time')).toHaveText('30:00');
  await expect(page.locator('#machine-clock-info')).toContainText('包干制');
  await page.locator('#new-game').click();
  await expect(page.locator('#main-minutes')).toHaveValue('30');
  await expect(page.locator('#time-control')).toHaveValue('absolute');
  await expect(page.locator('#increment-seconds')).toHaveValue('0');
  await expect(page.locator('#increment-seconds')).toBeDisabled();
  await expect(page.locator('#new-dialog')).toContainText('不另设单步时限');
  await page.locator('#allow-undo').check(); await page.locator('button[value=start]').click();
  await expect(page.locator('#new-dialog')).not.toBeVisible();
  // Select red soldier; exactly one legal dot. Invalid destination must not move it.
  await page.getByRole('button', { name: '红兵 A6', exact: true }).click();
  await expect(page.locator('.legal-dot')).toHaveCount(1);
  const box = await page.locator('#board').boundingBox(); if (!box) throw new Error('Board missing');
  await page.mouse.click(box.x + box.width * .5 / 9, box.y + box.height * 5.5 / 10);
  await expect(page.locator('#status-description')).toContainText('等待模型响应');
  await expect(page.locator('#record-count')).toHaveText('2 手');
  await expect(page.locator('#status-badge')).toHaveText('轮到你了');
  await expect(page.locator('#reason-text')).toContainText('自动化测试');
  await expect(page.locator('#reason-timing')).toContainText('模型往返');
  await expect(page.locator('#reason-timing')).toContainText('提交复查');
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
  await page.locator('#layers-toggle').click(); await expect(page.locator('#layers')).toContainText('review_move'); await expect(page.locator('#layers')).toContainText('compare_moves'); await expect(page.locator('#layers')).toContainText('search_position'); await expect(page.locator('#layers')).toContainText('update_plan'); await page.locator('#layers-close').click();
  await page.locator('#expert-open').click(); await expect(page.locator('#expert-dialog')).toBeVisible();
  await expect(page.locator('#expert-report')).toContainText('炮架是动态资源');
  await expect(page.locator('#expert-report')).toContainText('最近一次机器提交的独立复查');
  await expect(page.locator('#expert-report')).toContainText('局面评价 · 启发式而非胜率');
  await expect(page.locator('#expert-report')).toContainText('连续计划 · 每回合须重验');
  await expect(page.locator('#expert-report')).toContainText('实际落子的多步复查');
  await expect(page.locator('#expert-report')).toContainText('计算边界');
  await expect(page.locator('#expert-report')).toContainText('回合耗时分解');
  await expect(page.locator('#expert-report')).toContainText('首次响应增量');
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
  // Cancel a live model fixture: preserve interrupted timing and autosave it,
  // then retry without accepting late events from the cancelled attempt.
  await page.getByRole('button', { name: '红兵 A6', exact: true }).click();
  const cancelledBoard = await page.locator('#board').boundingBox(); if (!cancelledBoard) throw new Error('Board missing');
  await page.mouse.click(cancelledBoard.x + cancelledBoard.width * .5 / 9, cancelledBoard.y + cancelledBoard.height * 5.5 / 10);
  await expect(page.locator('#status-description')).toContainText('等待模型响应');
  await page.locator('#cancel').click();
  await expect(page.locator('#reason-timing')).toContainText('最近未落子尝试');
  const bootstrap = await page.evaluate(() => window.chess.bootstrap());
  if (!bootstrap.ok) throw new Error(bootstrap.error);
  const cancelledFile = path.join(dataDir, 'records', `${bootstrap.value.state.id}.json`);
  await expect.poll(async () => {
    try { return (await Bun.file(cancelledFile).json()).attempts?.some((a: any) => a.status === 'cancelled'); }
    catch { return false; }
  }).toBe(true);
  await page.locator('#retry').click(); await expect(page.locator('#record-count')).toHaveText('2 手');
  await page.locator('#undo').click(); await expect(page.locator('#record-count')).toHaveText('0 手');
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
  // Count synthesized notes from here on: resigning plays the machine-win phrase (4 notes).
  await page.evaluate(() => {
    (window as any).victoryNotes = 0;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { (window as any).victoryNotes++; return create.call(this); };
  });
  for (let i = 0; i < 2; i++) {
    await page.locator('#resign').click(); await page.locator('#confirm-yes').click(); await expect(page.locator('#machine-wins')).toHaveText(String(i + 1));
    await expect(page.locator('#victory')).toBeVisible(); await expect(page.locator('#victory')).toHaveClass(/machine/);
    await expect(page.locator('#victory-message')).toHaveText(i ? '大模型赢下整场比赛，来日再战！' : '这局大模型胜出，重整旗鼓再战！');
    await expect.poll(() => page.evaluate(() => (window as any).victoryNotes)).toBe(4 * (i + 1));
    expect(await page.locator('#victory').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    if (!i) {
      await page.screenshot({ path: 'artifacts/machine-win.png' });
      // A new round clears an in-flight celebration immediately.
      await page.locator('#next-round').click(); await expect(page.locator('#human-color')).toHaveText('执红 · 先手');
      await expect(page.locator('#victory')).toBeHidden();
    }
  }
  await expect(page.locator('#status-badge')).toHaveText('比赛结束'); await expect(page.locator('#next-round')).toBeHidden();
  // Real main-process timeout while settings stay open. Opening/canceling is not a pause.
  await page.locator('#new-game').click(); await page.locator('#best-of').selectOption('5'); await page.locator('#time-control').selectOption('absolute');
  await page.locator('#main-minutes').fill('0.05'); await page.locator('input[name=color][value="1"]').check(); await page.locator('button[value=start]').click();
  await expect(page.locator('#match-format')).toHaveText('五局三胜'); await page.locator('#new-game').click();
  await expect(page.locator('#status-badge')).toHaveText('本局结束', { timeout: 8000 }); await page.keyboard.press('Escape');
  await expect(page.locator('#human-time')).toHaveText('00:00'); await expect(page.locator('#status-description')).toContainText('棋钟耗尽');
  await page.screenshot({ path: 'artifacts/timeout.png' });
  // Human win through the real state bridge: confetti, chord (6 notes), no machine styling.
  const boot = await page.evaluate(() => window.chess.bootstrap()); if (!boot.ok) throw new Error(boot.error);
  async function sendState(value: GameState): Promise<void> {
    await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('chess:state', value), value);
  }
  const active: GameState = structuredClone(boot.value.state);
  active.id = 'celebration-fixture'; active.revision += 10; active.outcome = null; active.status = 'human';
  active.match.winner = null; active.match.humanWins = 0; active.match.machineWins = 0;
  await sendState(active); await expect(page.locator('#victory')).toBeHidden();
  const notesBefore = await page.evaluate(() => (window as any).victoryNotes as number);
  const win: GameState = structuredClone(active);
  win.revision++; win.status = 'over'; win.match.humanWins = 1;
  win.outcome = { gameId: win.id, number: 1, humanColor: win.human, winner: win.human, reason: 'checkmate' };
  await sendState(win);
  await expect(page.locator('#victory')).toBeVisible(); await expect(page.locator('#victory')).not.toHaveClass(/machine/);
  await expect(page.locator('#victory-message')).toHaveText('好棋，你赢了这一局！');
  await expect.poll(() => page.evaluate(() => (window as any).victoryNotes)).toBe(notesBefore + 6);
  await expect.poll(() => page.locator('#confetti').evaluate((canvas: HTMLCanvasElement) =>
    canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0))).toBe(true);
  await page.screenshot({ path: 'artifacts/victory-confetti.png' });
  // A duplicate push never replays the effect or its sound.
  await expect(page.locator('#victory')).toBeHidden({ timeout: 4500 });
  await sendState(win); await page.waitForTimeout(100);
  await expect(page.locator('#victory')).toBeHidden();
  expect(await page.evaluate(() => (window as any).victoryNotes)).toBe(notesBefore + 6);
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
  expect(await page.evaluate(() => Object.keys(window.chess).sort())).toEqual(['bootstrap', 'command', 'evaluation', 'exportRecord', 'onLearning', 'onState', 'rescanLearning', 'reviewGame']);
  expect(errors).toEqual([]);
  const files = await Array.fromAsync(new Bun.Glob('records/*.json').scan(dataDir)); expect(files.length).toBeGreaterThanOrEqual(3);
  const records = await Promise.all(files.map(f => Bun.file(path.join(dataDir, f)).json()));
  expect(records.every(r => r.format === 'chinese-chess/v1')).toBe(true);
  expect(records.some(r => r.attempts?.some((a: any) => a.status === 'cancelled' && a.timing.version === 'xiangqi-timing/v1'))).toBe(true);
  expect(records.some(r => r.match?.settings.timeControl === 'absolute' && r.match?.settings.mainTimeMs === 1800000 && r.match?.settings.incrementMs === 0)).toBe(true);
  const library = await Bun.file(path.join(dataDir, 'learning/library.json')).json();
  expect(library.cases).toHaveLength(2); expect(library.reviews.some((r: any) => r.gameId === 'smoke-learning-game')).toBe(true);
  expect(records.some(r => r.notes.some((n: any) => n.review?.coverage))).toBe(true);
  expect(records.some(r => r.notes.some((n: any) =>
    n.timing?.version === 'xiangqi-timing/v1' && n.timing.spans.some((s: any) => s.kind === 'model')))).toBe(true);
  expect(records.some(r => r.notes.some((n: any) => n.review?.search?.version === 'xiangqi-search/v1'))).toBe(true);
  expect(records.some(r => r.notes.some((n: any) => n.plan?.objective?.includes('UI fixture')))).toBe(true);
  expect(records.some(r => r.evaluations?.some((a: any) => a.expert?.version === 'xiangqi-expert/v1'))).toBe(true);
  console.log('PASS: real Electron + 32-piece board / capture / keyboard / replay / undo + no-scroll 900/760/700 + BO3/BO5 + clocks/timeout + offline music decoding + round-result celebrations + isolated IPC + autosave');
} finally { await application.close(); if (dataDir.includes('chinese-chess-smoke-')) await rm(dataDir, { recursive: true, force: true }); }
