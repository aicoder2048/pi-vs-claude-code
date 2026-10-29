// Pure domain layer: no Electron, Pi, network or filesystem dependencies.
export const SIZE = 15;
export type Color = 1 | 2;
export type Cell = 0 | Color;
export interface Point { x: number; y: number }
export interface Move extends Point { color: Color }
export interface Position {
  board: Cell[];
  moves: Move[];
  next: Color;
  winner: Color | 'draw' | null;
  winningLine: Point[];
}
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
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;
export const other = (c: Color): Color => c === 1 ? 2 : 1;
export const coordinate = ({ x, y }: Point): string => `${String.fromCharCode(65 + x)}${SIZE - y}`;
export const inside = (x: number, y: number): boolean => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
export const index = (x: number, y: number): number => y * SIZE + x;
export function emptyPosition(): Position {
  return { board: Array<Cell>(SIZE * SIZE).fill(0), moves: [], next: 1, winner: null, winningLine: [] };
}
function lineThrough(board: Cell[], x: number, y: number, color: Color): Point[] {
  for (const [dx, dy] of DIRECTIONS) {
    const points: Point[] = [{ x, y }];
    for (const sign of [-1, 1]) {
      let nx = x + sign * dx, ny = y + sign * dy;
      while (inside(nx, ny) && board[index(nx, ny)] === color) {
        points.push({ x: nx, y: ny });
        nx += sign * dx; ny += sign * dy;
      }
    }
    if (points.length >= 5) return points;
  }
  return [];
}
export function play(position: Position, point: Point, color = position.next): Position {
  if (position.winner) throw new Error('棋局已经结束');
  if (color !== position.next) throw new Error('尚未轮到该方落子');
  if (!inside(point.x, point.y)) throw new Error('坐标必须为 0–14 的整数');
  if (position.board[index(point.x, point.y)] !== 0) throw new Error('该交叉点已有棋子');
  const board = position.board.slice();
  board[index(point.x, point.y)] = color;
  const moves = [...position.moves, { x: point.x, y: point.y, color }];
  const winningLine = lineThrough(board, point.x, point.y, color);
  return { board, moves, next: other(color), winningLine, winner: winningLine.length ? color : moves.length === SIZE * SIZE ? 'draw' : null };
}
// The entire canonical record is replayed on EVERY committed move and undo.
export function replay(moves: readonly Move[]): Position {
  return moves.reduce((position, move) => play(position, move, move.color), emptyPosition());
}

// Evaluate all five-cell windows that contain this hypothetical stone, including
// broken threes/fours. Contiguous open ends provide additional shape information.
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
    // Tactical wins are scanned on ALL empty points; local pruning only affects suggestions.
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
  if (winningMoves.length) summary = `当前行棋方有 ${winningMoves.length} 个直接获胜点`;
  if (position.winner) summary = position.winner === 'draw' ? '棋盘已满，双方和棋' : `${position.winner === 1 ? '黑' : '白'}方连五获胜`;
  return { ply: position.moves.length, next: position.next, blackScore, whiteScore, summary,
    winningMoves: position.winner ? [] : winningMoves, mustBlock: position.winner ? [] : mustBlock,
    candidates: position.winner ? [] : candidates.slice(0, 12) };
}
export function boardText(position: Position): string {
  return ['   A B C D E F G H I J K L M N O', ...Array.from({ length: SIZE }, (_, y) =>
    `${String(SIZE - y).padStart(2)} ${position.board.slice(y * SIZE, (y + 1) * SIZE).map(c => c === 1 ? 'X' : c === 2 ? 'O' : '.').join(' ')}`)].join('\n');
}
