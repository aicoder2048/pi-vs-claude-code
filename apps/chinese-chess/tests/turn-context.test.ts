import { describe, expect, test } from 'bun:test';
import { GameService } from '../src/business/game-service';
import { analyzeExpert } from '../src/business/expert';
import { boardText, colorName, emptyPosition, play, type MoveInput } from '../src/business/engine';
import { retrieveKnowledge } from '../src/business/knowledge';
import { searchPosition } from '../src/business/search';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatSkillsForPrompt, loadSkillsFromDir, stripFrontmatter } from '@earendil-works/pi-coding-agent';
import { turnSignals, evaluationSummaries } from '../src/business/turn-context';
import { SKILLS_DIR } from './fixtures/skills';
import { SYSTEM } from '../src/agent/pi-driver';
import { turnPrompt } from '../src/agent/turn-prompt';
import { HUMAN_MISTAKES } from './fixtures/human-mistakes';
import { PASSIVE_GAME } from './fixtures/passive-game';

function fixture(moves: MoveInput[]) {
  const service = new GameService({ async run() {} }); const state = service.snapshot(); service.dispose();
  state.evaluations = []; let p = emptyPosition();
  for (const move of moves) {
    p = play(p, move); state.evaluations.push(analyzeExpert(p, { maxMs: 10000, maxNodes: 5000 }));
  }
  state.position = p; state.analysis = analyzeExpert(p, { maxMs: 10000, maxNodes: 5000 });
  state.analysis.expert!.knowledge = retrieveKnowledge(p, state.analysis.expert!);
  state.analysis.expert!.search = searchPosition(p, { maxMs: 1000, maxNodes: 2000 });
  return state;
}

describe('compact first-turn context', () => {
  for (const [name, moves] of [['initial', []], ['human-mistakes-before-42', HUMAN_MISTAKES.slice(0, 41)], ['passive-before-53', PASSIVE_GAME.slice(0, 52)]] as const) {
    test(`${name}: first system+user context is at least 40% smaller than full-report injection`, () => {
      const state = fixture([...moves]), before = JSON.stringify(state), p = state.position;
      // Test-only accounting: native system index plus /skill-expanded user prefix.
      // The real session's prompt construction is covered by pi-integration.test.ts.
      const system = SYSTEM + formatSkillsForPrompt(loadSkillsFromDir({ dir: SKILLS_DIR, source: 'app' }).skills, 'read') +
        stripFrontmatter(readFileSync(path.join(SKILLS_DIR, 'xiangqi-coach/SKILL.md'), 'utf8'));
      const compact = turnPrompt(state);
      // Full-report baseline: same skill prefix, full move coordinates, all summaries,
      // duplicated plan and full Analysis. Common headers omitted conservatively.
      const full = `现在轮到你，执${colorName(p.next)}。revision=${state.revision}。
${p.moves.map((m, i) => `${i + 1}. ${m.notation} ${JSON.stringify({ from: m.from, to: m.to })}`).join('\n')}
${boardText(p)}
${JSON.stringify(state.evaluations.map(({ ply, next, redScore, blackScore, summary }) => ({ ply, next, redScore, blackScore, summary })))}
${JSON.stringify(state.plan)}
${JSON.stringify(state.analysis)}`;
      const ratio = (system.length + compact.length) / (system.length + full.length);
      console.log(`${name}: ${system.length + full.length} → ${system.length + compact.length} chars (${Math.round((1 - ratio) * 100)}% less)`);
      expect(ratio).toBeLessThanOrEqual(.6);
      expect(system.length + compact.length).toBeLessThan(18000);
      expect(compact).not.toContain('rootScores'); expect(compact).not.toContain('legalMoves');
      expect(compact).toContain('signals'); expect(JSON.stringify(state)).toBe(before);
      expect(turnSignals(state).candidates!.length).toBeLessThanOrEqual(6);
      expect(turnSignals(state).threatened!.every(x => x.legalAttackers.length)).toBe(true);
    });
  }
  test('summary history keeps last 20 plus captures, once each, in chronological order', () => {
    const state = fixture(PASSIVE_GAME.slice(0, 52));
    const selected = evaluationSummaries(state).map(e => e.ply);
    expect(new Set(selected).size).toBe(selected.length);
    for (let i = 0; i < state.evaluations.length; i++) {
      expect(selected.includes(i + 1)).toBe(i >= state.evaluations.length - 20 || !!state.position.moves[i].captured);
    }
    expect(selected).toEqual([...selected].sort((a, b) => a - b));
  });
});
