import { at, controlsSquare, coordinate, glyph, inCheck, index, other, same, type Color, type Piece, type Point, type Position } from './engine';
import type { Phase } from './expert';

export interface PositionalEvaluation {
  development: number; mobility: number; coordination: number; kingPressure: number; constraints: number; wastedTempo: number; total: number;
  inactiveMajors: string[]; kingLineConstraints: string[]; repeatedMoves: string[];
}
const name = (p: Piece) => `${p.color === 1 ? '红' : '黑'}${glyph(p)}@${coordinate(p)}`;
const major = (p: Piece) => ['rook', 'horse', 'cannon'].includes(p.kind);
function rayFreedom(p: Position, piece: Piece): number {
  let n = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let x = piece.x + dx, y = piece.y + dy; x >= 0 && x < 9 && y >= 0 && y < 10; x += dx, y += dy) {
      if (at(p.board, { x, y })) break;
      n++;
    }
  }
  return n;
}

// Small, symmetric position terms. Geometry describes potential, NOT legal
// recapture/forced attack. Material and rule terminals are scored elsewhere.
export function evaluatePosition(p: Position, color: Color, phase: Phase): PositionalEvaluation {
  const out: PositionalEvaluation = { development: 0, mobility: 0, coordination: 0, kingPressure: 0,
    constraints: 0, wastedTempo: 0, total: 0, inactiveMajors: [], kingLineConstraints: [], repeatedMoves: [] };
  const own = p.board.filter(x => x?.color === color) as Piece[];
  const king = own.find(x => x.kind === 'king'), enemyKing = p.board.find(x => x?.color === other(color) && x.kind === 'king');
  const targets: { square: Point; board: Position['board']; attackers: string[] }[] = [];
  if (enemyKing) {
    for (let y = Math.max(0, enemyKing.y - 1); y <= Math.min(9, enemyKing.y + 1); y++) for (let x = 3; x <= 5; x++) {
      const square = { x, y }, board = p.board.slice();
      // Empty squares must be tested as captures: a cannon needs ONE screen,
      // not the zero-screen geometry of a non-capturing cannon move.
      board[index(square)] = { id: 'pressure-target', kind: 'pawn', color: other(color), ...square };
      targets.push({ square, board, attackers: [] });
    }
  }
  const checked = king ? inCheck(p.board, color) : false;
  for (const piece of own) {
    const advanced = color === 1 ? 9 - piece.y : piece.y, center = 4 - Math.abs(4 - piece.x);
    let freedom = 0, pressure = 0;
    if (major(piece)) {
      for (const target of targets) if (controlsSquare(target.board, piece, target.square)) { target.attackers.push(piece.id); pressure++; }
      if (piece.kind === 'horse') {
        for (const [dx, dy] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) {
          const to = { x: piece.x + dx, y: piece.y + dy };
          if (at(p.board, to)?.color !== color && controlsSquare(p.board, piece, to)) freedom++;
        }
        out.mobility += freedom * 4 + center * 2;
      } else {
        freedom = rayFreedom(p, piece);
        out.mobility += piece.kind === 'rook' ? freedom * 2 : Math.min(12, freedom);
      }
      const inactive = piece.kind === 'rook' ? advanced === 0 : piece.kind === 'horse' ? advanced === 0 || freedom <= 1
        : advanced <= 2 && pressure === 0;
      if (inactive) {
        out.inactiveMajors.push(name(piece));
        out.development -= phase === 'opening' ? 14 : phase === 'middlegame' ? 18 : 5;
      }
    } else if (piece.kind === 'pawn') out.mobility += advanced * 2 + center;
    else if (piece.kind === 'king' && phase !== 'endgame') out.mobility -= advanced * 8;
    // Only inspect pieces on the king's rank/file. This is deliberately a
    // king-line burden indicator, not a complete pin/horse-leg detector.
    if (!checked && king && piece.kind !== 'king' && (piece.x === king.x || piece.y === king.y)) {
      const without = p.board.slice(); without[index(piece)] = null;
      if (inCheck(without, color)) {
        out.kingLineConstraints.push(name(piece));
        out.constraints -= major(piece) ? 18 : 8;
      }
    }
  }
  const attackingPieces = new Set(targets.flatMap(t => t.attackers));
  out.kingPressure = Math.min(70, targets.reduce((n, t) => n + (t.attackers.length ? 7 : 0), 0));
  out.coordination = Math.min(36, targets.reduce((n, t) => n + (t.attackers.length >= 2 ? 9 : 0), 0))
    + Math.min(18, Math.max(0, attackingPieces.size - 1) * 6);
  const recent = p.moves.filter(m => m.color === color).slice(-4);
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1], b = recent[i];
    if (a.piece.id === b.piece.id && same(a.from, b.to) && same(a.to, b.from) && !a.check && !b.check && !a.captured && !b.captured) {
      out.repeatedMoves.push(b.notation); out.wastedTempo -= 8;
    }
  }
  out.total = out.development + out.mobility + out.coordination + out.kingPressure + out.constraints + out.wastedTempo;
  return out;
}
