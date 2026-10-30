// Authoritative free-Gomoku rules. No heuristics, Pi, Electron or I/O.
export const SIZE = 15;
export const RULESET = 'free-gomoku/v1' as const;
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
export const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;
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
export function boardText(position: Position): string {
  return ['   A B C D E F G H I J K L M N O', ...Array.from({ length: SIZE }, (_, y) =>
    `${String(SIZE - y).padStart(2)} ${position.board.slice(y * SIZE, (y + 1) * SIZE).map(c => c === 1 ? 'X' : c === 2 ? 'O' : '.').join(' ')}`)].join('\n');
}
