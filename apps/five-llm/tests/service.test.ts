import { describe, expect, test } from 'bun:test';
import { GameService, type AgentDriver, type TurnPort } from '../src/business/game-service';
import { DEFAULT_SETTINGS } from '../src/business/clock';
const model = { provider: 'test', id: 'fake', name: 'Test' };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
class ControlledDriver implements AgentDriver {
  turns: TurnPort[] = [];
  finishes: Array<() => void> = [];
  async run(port: TurnPort): Promise<void> { this.turns.push(port); await new Promise<void>(resolve => this.finishes.push(resolve)); }
}
describe('authoritative game service', () => {
  test('human → model tool commit → human with per-move evaluations', async () => {
    const driver = new ControlledDriver(), service = new GameService(driver, model);
    service.humanMove({ x: 7, y: 7 }, 0);
    expect(service.snapshot().status).toBe('thinking'); expect(service.snapshot().evaluations).toHaveLength(1);
    driver.turns[0].commit({ x: 8, y: 8 }, '控制中腹。'); driver.finishes[0](); await tick();
    const state = service.snapshot(); expect(state.status).toBe('human'); expect(state.evaluations).toHaveLength(2);
    expect(state.position.moves.map(m => m.color)).toEqual([1, 2]); expect(state.notes[0].reason).toBe('控制中腹。');
    expect(service.record().format).toBe('five-llm/v1'); service.dispose();
  });
  test('invalid model move can be corrected, duplicate commit rejected', () => {
    const driver = new ControlledDriver(), service = new GameService(driver, model);
    service.humanMove({ x: 7, y: 7 }, 0);
    expect(() => driver.turns[0].commit({ x: 7, y: 7 }, '重复')).toThrow();
    expect(service.snapshot().position.moves).toHaveLength(1);
    driver.turns[0].commit({ x: 6, y: 6 }, '合法');
    expect(() => driver.turns[0].commit({ x: 5, y: 5 }, '再下')).toThrow(); service.dispose();
  });
  test('snapshot isolation and stale human revision', () => {
    const service = new GameService({ async run() {} }, model), snapshot = service.snapshot();
    snapshot.position.board[0] = 2; expect(service.snapshot().position.board[0]).toBe(0);
    expect(() => service.humanMove({ x: 0, y: 0 }, 99)).toThrow('棋盘已更新'); service.dispose();
  });
  test('new game, undo, cancel and model switch invalidate late model responses', () => {
    for (const action of ['new', 'undo', 'cancel', 'model']) {
      const driver = new ControlledDriver(), service = new GameService(driver, model, { settings: { ...DEFAULT_SETTINGS, allowUndo: true } });
      service.humanMove({ x: 7, y: 7 }, 0); const old = driver.turns[0];
      if (action === 'new') service.newGame(1);
      if (action === 'undo') service.undo();
      if (action === 'cancel') service.cancel();
      if (action === 'model') service.setModel({ ...model, id: 'next' });
      expect(old.signal.aborted).toBe(true); expect(() => old.commit({ x: 5, y: 5 }, '迟到')).toThrow(); service.dispose();
    }
  });
  test('undo removes human move and LLM response; white player keeps machine opening', () => {
    const driver = new ControlledDriver(), service = new GameService(driver, model, { settings: { ...DEFAULT_SETTINGS, allowUndo: true } });
    service.newGame(2); driver.turns[0].commit({ x: 7, y: 7 }, '开局');
    let s = service.snapshot(); expect(s.status).toBe('human');
    service.humanMove({ x: 6, y: 7 }, s.revision); driver.turns[1].commit({ x: 8, y: 7 }, '连线');
    s = service.undo(); expect(s.position.moves).toHaveLength(1); expect(s.position.next).toBe(2);
    expect(s.notes).toHaveLength(1); expect(s.evaluations).toHaveLength(1); service.dispose();
  });
  test('missing model / failed provider / no tool move leave board untouched by AI', async () => {
    const absent = new GameService({ async run() {} }); absent.humanMove({ x: 7, y: 7 }, 0);
    expect(absent.snapshot().status).toBe('error'); expect(absent.snapshot().position.moves).toHaveLength(1); absent.dispose();
    for (const driver of [{ async run() {} }, { async run() { throw new Error('Network down'); } }]) {
      const service = new GameService(driver, model); service.humanMove({ x: 7, y: 7 }, 0); await tick();
      expect(service.snapshot().status).toBe('error'); expect(service.snapshot().position.moves).toHaveLength(1); service.dispose();
    }
  });
  test('cancel supports retry with new revision', () => {
    const driver = new ControlledDriver(), service = new GameService(driver, model);
    service.humanMove({ x: 7, y: 7 }, 0); service.cancel(); const paused = service.snapshot();
    expect(paused.status).toBe('paused'); service.retry(); expect(driver.turns).toHaveLength(2);
    expect(driver.turns[1].state.revision).toBe(paused.revision); service.dispose();
  });
});
