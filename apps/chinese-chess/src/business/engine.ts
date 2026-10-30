// Pure Xiangqi rules. No Electron, Pi, filesystem or model dependencies.
import type { ExpertReport } from './expert';
export type Color = 1 | 2; // 1 = red (first), 2 = black
export type Kind = 'king' | 'advisor' | 'elephant' | 'horse' | 'rook' | 'cannon' | 'pawn';
export interface Point { x: number; y: number }
export interface MoveInput { from: Point; to: Point }
export interface Piece extends Point { id: string; color: Color; kind: Kind }
export interface Move extends MoveInput { color: Color; piece: Piece; captured: Piece | null; check: boolean; notation: string }
export type BoardReason = 'checkmate' | 'stalemate' | 'repetition' | 'perpetual-check' | 'no-progress';
export interface Position {
  board: (Piece | null)[];
  next: Color;
  moves: Move[];
  winner: Color | 'draw' | null;
  endReason: BoardReason | null;
  keys: string[];
  quietPlies: number;
}
export interface Candidate extends MoveInput { score: number; label: string }
export interface Analysis {
  expert?: ExpertReport;
  ply: number; next: Color; inCheck: boolean; redScore: number; blackScore: number;
  legalMoves: MoveInput[]; candidates: Candidate[]; summary: string;
}
export const other = (color: Color): Color => color === 1 ? 2 : 1;
export const inside = (p: Point): boolean => !!p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < 9 && p.y >= 0 && p.y < 10;
export const index = (p: Point): number => p.y * 9 + p.x;
export const at = (board: (Piece | null)[], p: Point): Piece | null => inside(p) ? board[index(p)] : null;
export const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
export const coordinate = (p: Point): string => `${String.fromCharCode(65 + p.x)}${p.y}`;
export const moveText = (m: MoveInput): string => `${coordinate(m.from)} → ${coordinate(m.to)}`;
export const colorName = (c: Color): string => c === 1 ? '红' : '黑';
export const glyph = (p: Pick<Piece, 'kind' | 'color'>): string => ({
  king: p.color === 1 ? '帅' : '将', advisor: p.color === 1 ? '仕' : '士',
  elephant: p.color === 1 ? '相' : '象', horse: '马', rook: '车', cannon: '炮', pawn: p.color === 1 ? '兵' : '卒',
})[p.kind];
const palace = (p: Point, c: Color) => p.x >= 3 && p.x <= 5 && (c === 1 ? p.y >= 7 && p.y <= 9 : p.y >= 0 && p.y <= 2);
const crossed = (p: Point, c: Color) => c === 1 ? p.y <= 4 : p.y >= 5;
export const VALUES: Record<Kind, number> = { king: 10000, rook: 900, cannon: 450, horse: 400, elephant: 200, advisor: 200, pawn: 100 };
function key(board: (Piece | null)[], next: Color): string {
  return `${next}:` + board.map(p => p ? `${p.color}${p.kind[0]}${p.kind === 'king' ? 'k' : ''}` : '.').join(',');
}
export function positionFromPieces(pieces: Piece[], next: Color = 1): Position {
  const board: (Piece | null)[] = Array(90).fill(null);
  for (const p of pieces) {
    if (!inside(p) || board[index(p)]) throw new Error('无效或重叠棋子');
    board[index(p)] = { ...p };
  }
  return { board, next, moves: [], winner: null, endReason: null, keys: [key(board, next)], quietPlies: 0 };
}
export function emptyPosition(): Position {
  const pieces: Piece[] = [];
  const back: Kind[] = ['rook', 'horse', 'elephant', 'advisor', 'king', 'advisor', 'elephant', 'horse', 'rook'];
  for (const color of [1, 2] as const) {
    const home = color === 1 ? 9 : 0;
    back.forEach((kind, x) => pieces.push({ id: `${color}-${kind}-${x}`, kind, color, x, y: home }));
    for (const x of [1, 7]) pieces.push({ id: `${color}-cannon-${x}`, kind: 'cannon', color, x, y: color === 1 ? 7 : 2 });
    for (const x of [0, 2, 4, 6, 8]) pieces.push({ id: `${color}-pawn-${x}`, kind: 'pawn', color, x, y: color === 1 ? 6 : 3 });
  }
  return positionFromPieces(pieces);
}
// Attack geometry intentionally ignores pins, as is conventional for king safety.
// Flying generals are attacks only, not an ordinary king move across the river.
function geometry(board: (Piece | null)[], p: Piece, to: Point, attack = false): boolean {
  if (!inside(to) || same(p, to)) return false;
  const dx = to.x - p.x, dy = to.y - p.y, ax = Math.abs(dx), ay = Math.abs(dy), target = at(board, to);
  if (target?.color === p.color) return false;
  switch (p.kind) {
    case 'king':
      if (attack && target?.kind === 'king' && dx === 0) return screens(board, p, to) === 0;
      return ax + ay === 1 && palace(to, p.color);
    case 'advisor': return ax === 1 && ay === 1 && palace(to, p.color);
    case 'elephant': return ax === 2 && ay === 2 && (p.color === 1 ? to.y >= 5 : to.y <= 4) && !at(board, { x: p.x + dx / 2, y: p.y + dy / 2 });
    case 'horse':
      return ((ax === 2 && ay === 1) || (ax === 1 && ay === 2)) && !at(board, { x: p.x + (ax === 2 ? Math.sign(dx) : 0), y: p.y + (ay === 2 ? Math.sign(dy) : 0) });
    case 'rook': return (dx === 0 || dy === 0) && screens(board, p, to) === 0;
    case 'cannon': return (dx === 0 || dy === 0) && screens(board, p, to) === (target ? 1 : 0);
    case 'pawn': return (dx === 0 && dy === (p.color === 1 ? -1 : 1)) || (crossed(p, p.color) && ax === 1 && dy === 0);
  }
}
function screens(board: (Piece | null)[], from: Point, to: Point): number {
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  let count = 0;
  for (let x = from.x + dx, y = from.y + dy; x !== to.x || y !== to.y; x += dx, y += dy) if (board[y * 9 + x]) count++;
  return count;
}
export function inCheck(board: (Piece | null)[], color: Color): boolean {
  const king = board.find(p => p?.kind === 'king' && p.color === color);
  if (!king) return true;
  return board.some(p => p && p.color !== color && geometry(board, p, king, true));
}
function moved(board: (Piece | null)[], input: MoveInput): (Piece | null)[] {
  const copy = board.slice(), piece = at(board, input.from)!;
  copy[index(input.from)] = null; copy[index(input.to)] = { ...piece, x: input.to.x, y: input.to.y };
  return copy;
}
// Geometric support is NOT proof of a legal recapture (pins, horse legs and
// cannon screens can change when a piece is captured).
export function controlsSquare(board: (Piece | null)[], piece: Piece, to: Point): boolean {
  const target = at(board, to);
  if (!target || target.color !== piece.color) return geometry(board, piece, to, true);
  const copy = board.slice(); copy[index(to)] = { ...target, color: other(piece.color) };
  return geometry(copy, piece, to, true);
}
export function legalCapturesTo(position: Pick<Position, 'board' | 'next' | 'winner'>, to: Point): MoveInput[] {
  const target = at(position.board, to);
  if (position.winner || !target || target.color === position.next || target.kind === 'king') return [];
  return position.board.flatMap(p => p && p.color === position.next && geometry(position.board, p, to) && !inCheck(moved(position.board, { from: p, to }), p.color)
    ? [{ from: { x: p.x, y: p.y }, to: { x: to.x, y: to.y } }] : []);
}
export function legalCaptures(position: Pick<Position, 'board' | 'next' | 'winner'>): MoveInput[] {
  return position.board.flatMap(p => p && p.color !== position.next && p.kind !== 'king' ? legalCapturesTo(position, p) : []);
}
export function legalMoves(position: Pick<Position, 'board' | 'next' | 'winner'>, from?: Point, limit = Infinity): MoveInput[] {
  if (position.winner) return [];
  const result: MoveInput[] = [];
  for (const p of position.board) {
    if (!p || p.color !== position.next || (from && !same(p, from))) continue;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const to = { x, y };
      if (at(position.board, to)?.kind === 'king') continue;
      if (geometry(position.board, p, to) && !inCheck(moved(position.board, { from: p, to }), p.color)) {
        result.push({ from: { x: p.x, y: p.y }, to });
        if (result.length >= limit) return result;
      }
    }
  }
  return result;
}
export function play(position: Position, input: MoveInput): Position {
  if (position.winner) throw new Error('本局已结束');
  if (!input || !inside(input.from) || !inside(input.to)) throw new Error('坐标须为 x=0..8、y=0..9 的整数');
  const piece = at(position.board, input.from), captured = at(position.board, input.to);
  if (!piece || piece.color !== position.next) throw new Error('起点没有当前行棋方的棋子');
  if (captured?.color === piece.color) throw new Error('不能吃自己的棋子');
  if (captured?.kind === 'king' || !geometry(position.board, piece, input.to)) throw new Error('不符合棋子走法（请检查马腿、象眼、炮架、河界及九宫）');
  const board = moved(position.board, input);
  if (inCheck(board, piece.color)) throw new Error('此步导致己方被将军或将帅照面，必须应将');
  const next = other(position.next), check = inCheck(board, next);
  const move: Move = { from: { x: input.from.x, y: input.from.y }, to: { x: input.to.x, y: input.to.y }, color: piece.color, piece: { ...piece }, captured: captured ? { ...captured } : null,
    check, notation: `${colorName(piece.color)}${glyph(piece)} ${moveText(input)}${captured ? ` 吃${glyph(captured)}` : ''}${check ? ' 将军' : ''}` };
  const nextKey = key(board, next);
  const out: Position = { board, next, moves: [...position.moves, move], winner: null, endReason: null, keys: [...position.keys, nextKey],
    quietPlies: captured || piece.kind === 'pawn' ? 0 : position.quietPlies + 1 };
  if (!legalMoves(out, undefined, 1).length) { out.winner = piece.color; out.endReason = check ? 'checkmate' : 'stalemate'; }
  else {
    const repeats = out.keys.flatMap((k, i) => k === nextKey ? [i] : []);
    if (repeats.length >= 3) {
      const cycle = out.moves.slice(repeats[repeats.length - 3]);
      const perpetual = ([1, 2] as const).filter(c => { const own = cycle.filter(m => m.color === c); return own.length > 0 && own.every(m => m.check); });
      out.winner = perpetual.length === 1 ? other(perpetual[0]) : 'draw';
      out.endReason = perpetual.length === 1 ? 'perpetual-check' : 'repetition';
    } else if (out.quietPlies >= 120) { out.winner = 'draw'; out.endReason = 'no-progress'; }
  }
  return out;
}
export function replay(moves: readonly MoveInput[]): Position { return moves.reduce((p, m) => play(p, m), emptyPosition()); }
export function analyze(position: Position): Analysis {
  const scores = { 1: 0, 2: 0 };
  for (const p of position.board) if (p) scores[p.color] += VALUES[p.kind] + (p.kind === 'pawn' && crossed(p, p.color) ? 80 : 0);
  const legal = legalMoves(position);
  const candidates = legal.map(m => {
    const target = at(position.board, m.to), piece = at(position.board, m.from)!;
    const board = moved(position.board, m), checking = inCheck(board, other(position.next));
    const progress = piece.color === 1 ? m.from.y - m.to.y : m.to.y - m.from.y;
    const score = (target ? VALUES[target.kind] : 0) + (checking ? 65 : 0) + progress * 4 + (4 - Math.abs(4 - m.to.x)) * 2;
    return { ...m, score, label: `${glyph(piece)} ${moveText(m)}${target ? ` · 吃${glyph(target)}` : ''}${checking ? ' · 将军' : ''}` };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
  const check = inCheck(position.board, position.next);
  return { ply: position.moves.length, next: position.next, inCheck: check, redScore: scores[1], blackScore: scores[2], legalMoves: legal, candidates,
    summary: position.winner ? `终局：${position.endReason}` : `${colorName(position.next)}方${check ? '被将军，须应将' : '行棋'} · ${legal.length} 种合法走法 · 子力差（红−黑）${scores[1] - scores[2]}。候选仅为启发式，不是胜率或搜索结论。` };
}
export function boardText(position: Position): string {
  const symbols: Record<Kind, string> = { king: 'K', advisor: 'A', elephant: 'E', horse: 'H', rook: 'R', cannon: 'C', pawn: 'P' };
  return '    A B C D E F G H I\n' + Array.from({ length: 10 }, (_, y) => `${y}   ` + Array.from({ length: 9 }, (_, x) => {
    const p = at(position.board, { x, y }); return p ? p.color === 1 ? symbols[p.kind] : symbols[p.kind].toLowerCase() : '.';
  }).join(' ')).join('\n') + '\n大写=红，小写=黑；y=0 黑方底线，y=9 红方底线。';
}
