import type { GameState } from '../shared/types';

// Projection only: the authoritative analysis remains intact for tools and UI.
export function turnSignals(state: GameState) {
  const { analysis, position: p } = state, e = analysis.expert, search = e?.search;
  return {
    inCheck: analysis.inCheck, lastMove: e?.lastMove ?? p.moves.at(-1)?.notation ?? null,
    phase: e?.phase, priorities: e?.priorities, material: e?.material,
    threatened: e?.safety.filter(x => x.color === p.next && x.legalAttackers.length).map(x => ({
      piece: x.piece, square: x.square, value: x.value, legalAttackers: x.legalAttackers,
      geometricDefenders: x.geometricDefenders, pinnedToKing: x.pinnedToKing, loose: x.loose,
    })),
    principles: e?.principles.map(({ id, evidence }) => ({ id, evidence })),
    candidates: e?.candidates.slice(0, 6).map(({ move, notation, risk, estimatedNet, line, coverage }) => ({
      move, notation, risk, estimatedNet, line,
      coverage: { complete: coverage.complete, exchangeComplete: coverage.exchangeComplete, quietThreatsComplete: coverage.quietThreatsComplete },
    })),
    search: search ? { bestMove: search.bestMove, completedDepth: search.completedDepth,
      rootScope: search.rootScope, searchedRoots: search.searchedRoots, legalRoots: search.legalRoots,
      stopped: search.stopped, line: search.candidates[0]?.line, limitations: search.limitations } : undefined,
    searchError: e?.searchError, knowledge: e?.knowledge, experiences: e?.experiences,
    plan: state.plan, coverage: e?.coverage, limitations: e?.limitations,
  };
}
export function evaluationSummaries(state: GameState) {
  return state.evaluations.filter((_, i) => i >= state.evaluations.length - 20 || state.position.moves[i]?.captured)
    .map(({ ply, next, redScore, blackScore, summary }) => ({ ply, next, redScore, blackScore, summary }));
}
