import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/business/clock';
import { validateCandidate } from '../src/business/decision';
import { analyze, coordinate, emptyPosition, play, replay, SIZE, type Point, type Position } from '../src/business/engine';
import { checkForcingSequences } from '../src/business/forcing';
import { GameService, type TurnPort } from '../src/business/game-service';
import { missedWhiteWinCase as fixture, missedWhiteWinPosition, point } from './fixtures/positions';

function* legalReplies(position: Position): Generator<Position> {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (!position.board[y * SIZE + x]) yield play(position, { x, y });
  }
}

describe('live-game regression: white misses the G10 forcing win at ply 14', () => {
  test('preserves the pre-decision position, not a timeout-based win/loss label', () => {
    const p = missedWhiteWinPosition(), a = analyze(p);
    expect(p.moves).toHaveLength(13); expect(p.next).toBe(2); expect(p.winner).toBeNull();
    expect(a.winningMoves).toEqual([]); expect(a.mustBlock).toEqual([]);
    expect(validateCandidate(p, point(fixture.winningCandidate))).toMatchObject({
      legal: true, coordinate: 'G10', winner: null, opponentImmediateWinsAfter: [], warnings: [],
    });
    const exported = fixture.observedContinuation.reduce((p, text) => play(p, point(text)), p);
    expect(exported.moves).toHaveLength(fixture.source.exportedPly);
    expect(exported.winner).toBeNull(); expect(exported.next).toBe(1);
    expect(exported.moves.slice(13).map(coordinate)).toEqual(['H6', 'G10', 'E9']);
  });

  test('G10 forces G8: EVERY other black reply loses to white G8', () => {
    const original = missedWhiteWinPosition(), before = structuredClone(original);
    const p = play(original, point(fixture.winningCandidate));
    expect(p.winner).toBeNull();
    expect(analyze(p).winningMoves).toEqual([]); // Black cannot win before defending.
    expect(analyze(p).mustBlock.map(coordinate)).toEqual(['G8']);
    let checked = 0;
    for (const reply of legalReplies(p)) {
      expect(reply.winner).toBeNull();
      if (coordinate(reply.moves.at(-1)!) === 'G8') continue;
      expect(play(reply, point('G8')).winner).toBe(2); checked++;
    }
    expect(checked).toBe(SIZE * SIZE - p.moves.length - 1);
    expect(original).toEqual(before);
  });

  test('after forced G8, J7 wins against EVERY legal black reply, not just a cooperative line', () => {
    const p = fixture.forcingLine.reduce((p, text) => play(p, point(text)), missedWhiteWinPosition());
    expect(p.moves).toHaveLength(16); expect(p.winner).toBeNull();
    expect(analyze(p).winningMoves).toEqual([]);
    expect(analyze(p).mustBlock.map(coordinate)).toEqual(fixture.winningPoints);
    let checked = 0;
    for (const reply of legalReplies(p)) {
      expect(reply.winner).toBeNull(); // No black counter-win anywhere on the board.
      const finish = fixture.winningPoints.find(text => {
        const { x, y } = point(text); return !reply.board[y * SIZE + x];
      });
      expect(finish).toBeDefined();
      const won = play(reply, point(finish!));
      expect(won.winner).toBe(2); expect(won.winningLine.length).toBeGreaterThanOrEqual(5);
      checked++;
    }
    expect(checked).toBe(SIZE * SIZE - p.moves.length);
  });

  test('the same forcing line survives all eight rotations/reflections', () => {
    for (let reflect = 0; reflect < 2; reflect++) for (let rotations = 0; rotations < 4; rotations++) {
      const transform = (p: Point): Point => {
        let x = reflect ? SIZE - 1 - p.x : p.x, y = p.y;
        for (let i = 0; i < rotations; i++) [x, y] = [SIZE - 1 - y, x];
        return { x, y };
      };
      let p = fixture.moves.reduce((p, text) => play(p, transform(point(text))), emptyPosition());
      p = play(p, transform(point('G10')));
      expect(p.winner).toBeNull(); expect(analyze(p).winningMoves).toEqual([]);
      expect(analyze(p).mustBlock).toEqual([transform(point('G8'))]);
      p = play(p, transform(point('G8'))); p = play(p, transform(point('J7')));
      expect(analyze(p).winningMoves).toEqual([]);
      expect(analyze(p).mustBlock.map(coordinate).sort()).toEqual(fixture.winningPoints.map(text => coordinate(transform(point(text)))).sort());
      for (const [block, finish] of [['F11', 'K6'], ['K6', 'F11']]) {
        expect(play(play(p, transform(point(block))), transform(point(finish))).winner).toBe(2);
      }
    }
  });

  test('opponent-only refutation is not an own-win detector or a move-quality comparison', async () => {
    const original = missedWhiteWinPosition();
    // Document the existing tool scope, NOT an assertion that H6 is as good as G10.
    // Own-win discovery and missed-win feedback are separate capabilities, covered by
    // own-forcing.test.ts and the real Pi integration G10 tests.
    for (const candidate of [fixture.actualCandidate, fixture.winningCandidate]) {
      expect(validateCandidate(original, point(candidate)).warnings).toEqual([]);
      const result = await checkForcingSequences(original, point(candidate));
      expect(result.scope).toBe('opponent-continuous-four-only');
      expect(result.status).toBe('not-found-within-budget');
      expect(result.proof).toBeUndefined();
    }
  });

  test('a subsequent human timeout settles the round but does not change the earlier tactical position', () => {
    let now = 0, port: TurnPort | undefined;
    const service = new GameService({ async run(next) { port = next; } },
      { provider: 'test', id: 'record-replay', name: 'Recorded moves, not LLM' },
      { now: () => now, settings: DEFAULT_SETTINGS });
    try {
      for (const text of [...fixture.moves, ...fixture.observedContinuation]) {
        const state = service.snapshot();
        if (state.position.next === state.human) service.humanMove(point(text), state.revision);
        else port!.commit(point(text), '回放导出的实际落子，不进行模型推理');
      }
      const beforeTimeout = service.record();
      expect(beforeTimeout.outcome).toBeNull(); expect(beforeTimeout.moves).toHaveLength(16);
      expect(service.snapshot().clock.running).toBe(1);
      // Deterministic simulated timeout; the source export itself was still unfinished.
      now = DEFAULT_SETTINGS.mainTimeMs + DEFAULT_SETTINGS.periods * DEFAULT_SETTINGS.periodTimeMs;
      service.tick();
      const afterTimeout = service.record();
      expect(afterTimeout.outcome).toMatchObject({ winner: 2, reason: 'byoyomi' });
      expect(afterTimeout.result).toBe(2);
      expect(afterTimeout.moves).toEqual(beforeTimeout.moves);
      expect(service.snapshot().position.winner).toBeNull(); // White won on time, not by five.
      expect(replay(afterTimeout.moves.slice(0, 13))).toEqual(missedWhiteWinPosition());
      const finish = fixture.forcingLine.reduce((p, text) => play(p, point(text)), replay(afterTimeout.moves.slice(0, 13)));
      expect(analyze(finish).mustBlock.map(coordinate)).toEqual(fixture.winningPoints);
    } finally { service.dispose(); }
  });
});
