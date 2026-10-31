import { describe, expect, test } from 'bun:test';
import { emptyPosition, play, positionFromPieces, type MoveInput } from '../src/business/engine';
import { analyzeExpert } from '../src/business/expert';
import { KNOWLEDGE_SOURCES, OPENING_LINES, knowledgeStats, retrieveKnowledge } from '../src/business/knowledge';
import { replayCasePrefix, SYMMETRIES } from '../src/business/learning';
import ccpd from '../src/data/ccpd/openings.json';
import { createHash } from 'node:crypto';
const move = (s: string): MoveInput => ({ from: { x: s.charCodeAt(0) - 65, y: +s[1] }, to: { x: s.charCodeAt(2) - 65, y: +s[3] } });
const knowledge = (p = emptyPosition()) => retrieveKnowledge(p, analyzeExpert(p).expert!);
describe('sourced, on-demand expert knowledge (no network at runtime)', () => {
  test('12 starter + 61 accepted CCPD lines replay legally; 1360 exact position nodes', () => {
    expect(knowledgeStats()).toEqual({ openings: 73, indexedPositions: 1360, sources: 7 });
    for (const line of OPENING_LINES) { let p = emptyPosition(); for (const s of line.moves) p = play(p, move(s)); expect(p.winner).toBeNull(); }
  });
  test('CCPD preserves attribution, pinned revision, license hash and legal source prefixes', async () => {
    expect(ccpd.lines).toHaveLength(61); expect(ccpd.rejected).toHaveLength(3);
    expect(ccpd.lines.length + ccpd.rejected.length).toBe(64);
    expect(ccpd.rejected.every(r => r.reason === '只接收标准初始阵型开局')).toBe(true);
    expect(ccpd.license).toBe('CC-BY-4.0'); expect(ccpd.attribution).toContain('Yu-Han Tseng and Bo-Nian Chen');
    const license = await Bun.file(new URL('../src/data/ccpd/UPSTREAM-LICENSE.txt', import.meta.url)).text();
    expect(createHash('sha256').update(license).digest('hex')).toBe(ccpd.licenseSha256);
    for (const line of ccpd.lines) {
      expect(line.moves).toHaveLength(20); expect(line.sha256).toMatch(/^[a-f0-9]{64}$/);
      let p = emptyPosition(); for (const m of line.moves) p = play(p, m);
      expect(p.winner).toBeNull();
    }
    let p = emptyPosition(); for (const m of ccpd.lines[0].moves.slice(0, 12)) p = play(p, m);
    const hints = knowledge(p).filter(h => h.source.id === 'ccpd');
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint.source.url).toContain(ccpd.commit); expect(hint.source.usage).toContain('CC-BY-4.0');
      if (hint.currentMove) expect(() => play(p, hint.currentMove!)).not.toThrow();
    }
  });
  test('every hint has provenance, applicability and exceptions, not a naked best-move claim', () => {
    const hints = knowledge(); expect(hints.length).toBeGreaterThan(0); expect(hints.length).toBeLessThanOrEqual(5);
    for (const h of hints) { expect(h.source.url).toMatch(/^https:\/\//); expect(h.applicability.length).toBeGreaterThan(0); expect(h.caution.length).toBeGreaterThan(0); }
    expect(KNOWLEDGE_SOURCES.every(x => x.usage.includes('不') || x.usage.includes('独立'))).toBe(true);
  });
  test('after central cannon, exact board match supplies legal replies and tactical coverage', () => {
    const p = play(emptyPosition(), move('H7E7'));
    const hints = knowledge(p).filter(x => x.currentMove);
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) { expect(() => play(p, hint.currentMove!)).not.toThrow(); expect(hint.verification).toBe('legal-and-tactically-reviewed'); }
  });
  test('all symmetries and alternate move orders match diagrams, not just move-string prefixes', () => {
    const prefix = ['H7E7','B0C2','H9G7','H0G2','I9H9','I0H0'].map(move);
    for (const s of SYMMETRIES) {
      const p = replayCasePrefix(prefix, s); const hints = knowledge(p);
      expect(hints.some(h => h.kind === 'opening-position')).toBe(true);
      for (const hint of hints) if (hint.currentMove) expect(() => play(p, hint.currentMove!)).not.toThrow();
    }
  });
  test('deviating from the repertoire does not inject the named opening continuation', () => {
    let p = emptyPosition(); for (const s of ['H7E7','H0G2','A6A5']) p = play(p, move(s));
    expect(knowledge(p).filter(h => h.kind === 'opening-position')).toHaveLength(0);
    expect(knowledge(p).some(h => h.kind === 'conditional-principle')).toBe(true);
  });
  test('endgame advice explicitly refuses to declare theoretical wins/draws', () => {
    const p = positionFromPieces([{ id: 'k1', kind: 'king', color: 1, x: 4, y: 9 }, { id: 'k2', kind: 'king', color: 2, x: 3, y: 0 }, { id: 'p', kind: 'pawn', color: 1, x: 0, y: 4 }]);
    const hint = knowledge(p).find(x => x.id === 'endgame-exchanges'); expect(hint?.caution).toContain('不能直接裁定胜和');
  });
});
