// Heuristic evaluation, deliberately separate from authoritative rules.
import { DIRECTIONS, SIZE, coordinate, index, inside, other, type Cell, type Color, type Point, type Position } from './rules';
export interface Candidate extends Point {
  coordinate: string;
  attack: number;
  defense: number;
  score: number;
  tags: string[];
}
export interface Analysis {
  ply: number;
  next: Color;
  blackScore: number;
  whiteScore: number;
  summary: string;
  winningMoves: Point[];
  mustBlock: Point[];
  candidates: Candidate[];
}
// Five-cell windows include broken threes/fours. These shape counts do NOT
// prove a forcing sequence or implement Renju live-three/forbidden-move rules.
function potential(board: Cell[], x: number, y: number, color: Color): { score: number; four: number; three: number; win: boolean } {
  let score = 0, four = 0, three = 0, win = false;
  for (const [dx, dy] of DIRECTIONS) {
    let count = 1, open = 0;
    for (const sign of [-1, 1]) {
      let n = 1;
      while (inside(x + dx * n * sign, y + dy * n * sign) && board[index(x + dx * n * sign, y + dy * n * sign)] === color) { count++; n++; }
      if (inside(x + dx * n * sign, y + dy * n * sign) && board[index(x + dx * n * sign, y + dy * n * sign)] === 0) open++;
    }
    if (count >= 5) win = true;
    if (count === 4 && open === 2) score += 12000;
    if (count === 3 && open === 2) score += 900;
    let best = 0;
    for (let offset = -4; offset <= 0; offset++) {
      let stones = 0, valid = true;
      for (let k = 0; k < 5; k++) {
        const nx = x + (offset + k) * dx, ny = y + (offset + k) * dy;
        if (!inside(nx, ny)) { valid = false; break; }
        const cell = nx === x && ny === y ? color : board[index(nx, ny)];
        if (cell === other(color)) { valid = false; break; }
        if (cell === color) stones++;
      }
      if (valid) best = Math.max(best, stones);
    }
    if (best === 4) four++;
    if (best === 3) three++;
    score += [0, 1, 12, 150, 2400, 1000000][best];
  }
  if (four >= 2) score += 25000;
  if (three >= 2) score += 2200;
  return { score: win ? 1000000 : score, four, three, win };
}
export function analyze(position: Position): Analysis {
  const candidates: Candidate[] = [], winningMoves: Point[] = [], mustBlock: Point[] = [];
  let blackScore = 0, whiteScore = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (position.board[index(x, y)]) continue;
    const black = potential(position.board, x, y, 1), white = potential(position.board, x, y, 2);
    blackScore = Math.max(blackScore, black.score); whiteScore = Math.max(whiteScore, white.score);
    const attack = position.next === 1 ? black : white, defense = position.next === 1 ? white : black;
    if (attack.win) winningMoves.push({ x, y });
    if (defense.win) mustBlock.push({ x, y });
    // Tactical wins scan ALL empty points; local pruning only affects suggestions.
    const near = position.moves.length === 0 ? x === 7 && y === 7 : position.moves.some(m => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= 2);
    if (!near) continue;
    const tags: string[] = [];
    if (attack.win) tags.push('立即成五');
    if (defense.win) tags.push('阻止成五');
    if (attack.four >= 2) tags.push('双四');
    else if (attack.four) tags.push('冲四');
    if (attack.three >= 2) tags.push('双三');
    const center = 14 - Math.abs(x - 7) - Math.abs(y - 7);
    candidates.push({ x, y, coordinate: coordinate({ x, y }), attack: attack.score, defense: defense.score,
      score: attack.win ? 1e9 : defense.win ? 1e8 + attack.score : Math.round(attack.score + defense.score * 1.1 + center), tags });
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  let summary = '开局布局，争取中腹与连线空间';
  if (position.moves.length) summary = '局势计算完成：优先兼顾自身连线与对手威胁';
  if (mustBlock.length) summary = `对手有 ${mustBlock.length} 个成五点，需要防守`;
  if (mustBlock.length > 1) summary += '；单点封堵可能无法消除全部威胁';
  if (winningMoves.length) summary = `当前行棋方有 ${winningMoves.length} 个直接获胜点`;
  if (position.winner) summary = position.winner === 'draw' ? '棋盘已满，双方和棋' : `${position.winner === 1 ? '黑' : '白'}方连五获胜`;
  return { ply: position.moves.length, next: position.next, blackScore, whiteScore, summary,
    winningMoves: position.winner ? [] : winningMoves, mustBlock: position.winner ? [] : mustBlock,
    candidates: position.winner ? [] : candidates.slice(0, 12) };
}
