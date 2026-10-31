import { describe, expect, test } from 'bun:test';
import { turnGuidance } from '../src/business/decision';
import { GameService } from '../src/business/game-service';
import { analyzeExpert, phaseOf } from '../src/business/expert';
import { emptyPosition, inCheck, positionFromPieces, replay, type Position } from '../src/business/engine';
import { HUMAN_MISTAKES } from './fixtures/human-mistakes';
import { PASSIVE_GAME } from './fixtures/passive-game';

function state(p: Position = emptyPosition()) {
  const service = new GameService({ async run() {} }); const s = service.snapshot(); service.dispose();
  return { ...s, position: p, analysis: analyzeExpert(p, { maxMs: 0, maxNodes: 0 }) };
}
describe('deterministic skill routing', () => {
  test('terminal never starts; in-check outranks time, attack and phase', () => {
    const s = state(positionFromPieces([
      { id: 'r', kind: 'king', color: 1, x: 4, y: 9 }, { id: 'b', kind: 'king', color: 2, x: 3, y: 0 },
      { id: 'rook', kind: 'rook', color: 2, x: 4, y: 5 },
    ]));
    s.clock.players[1].mainMs = 1;
    expect(turnGuidance(s)?.playbook).toBe('playbook-in-check');
    s.position.winner = 2; expect(turnGuidance(s)).toBeNull();
    s.position.winner = null; s.outcome = { gameId: s.id, number: 1, humanColor: 1, winner: 2, reason: 'resign' };
    expect(turnGuidance(s)).toBeNull();
  });
  test('clock thresholds honor absolute control and average recent think time', () => {
    const s = state(); s.match.settings.timeControl = 'fischer';
    s.analysis.expert!.safety = []; s.clock.players[1].mainMs = 60000;
    expect(turnGuidance(s)?.playbook).toBe('playbook-opening');
    s.clock.players[1].mainMs--; expect(turnGuidance(s)?.playbook).toBe('playbook-time-pressure');
    s.clock.players[1].mainMs = 80000; s.match.settings.timeControl = 'absolute';
    expect(turnGuidance(s)?.playbook).toBe('playbook-time-pressure');
    s.match.settings.timeControl = 'fischer';
    s.notes = [{ ply: 2, reason: 'test', model: 'test', elapsedMs: 30000 }];
    expect(turnGuidance(s)?.playbook).toBe('playbook-time-pressure');
  });
  test('attacked own major outranks phase, but clock outranks attacked major', () => {
    const s = state();
    s.analysis.expert!.safety = [{ piece: '受攻车', id: 'r', color: 1, square: { x: 0, y: 9 }, value: 900,
      legalAttackers: ['对方炮'], geometricDefenders: [], loose: true, pinnedToKing: false }];
    expect(turnGuidance(s)?.playbook).toBe('playbook-under-attack');
    s.clock.players[1].mainMs = 1000; expect(turnGuidance(s)?.playbook).toBe('playbook-time-pressure');
    s.clock.players[1].mainMs = 3000000; s.analysis.expert!.safety[0].color = 2;
    expect(turnGuidance(s)?.playbook).toBe('playbook-opening');
  });
  test('three phases and real fixtures follow the policy without mutating state', () => {
    const distribution = new Set<string>();
    for (const moves of [HUMAN_MISTAKES, PASSIVE_GAME]) for (let i = 0; i <= moves.length; i++) {
      const s = state(replay(moves.slice(0, i))), before = JSON.stringify(s), guidance = turnGuidance(s);
      expect(JSON.stringify(s)).toBe(before);
      if (s.position.winner) { expect(guidance).toBeNull(); continue; }
      const expected = inCheck(s.position.board, s.position.next) ? 'playbook-in-check' :
        s.analysis.expert!.safety.some(x => x.color === s.position.next && x.value >= 400 && x.legalAttackers.length) ?
          'playbook-under-attack' : `playbook-${phaseOf(s.position)}` as const;
      expect(guidance?.playbook).toBe(expected); distribution.add(expected);
    }
    expect(distribution.has('playbook-opening')).toBe(true);
    expect(distribution.has('playbook-middlegame')).toBe(true);
    expect(distribution.has('playbook-under-attack')).toBe(true);
    const end = state(positionFromPieces([{ id: 'r', kind: 'king', color: 1, x: 4, y: 9 }, { id: 'b', kind: 'king', color: 2, x: 3, y: 0 }]));
    expect(turnGuidance(end)?.playbook).toBe('playbook-endgame');
  });
});
