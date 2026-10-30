import { at, emptyPosition, legalMoves, play, type Kind, type MoveInput, type Position } from './engine';
const kinds: Record<string, Kind> = { 车: 'rook', 马: 'horse', 炮: 'cannon', 相: 'elephant', 象: 'elephant', 仕: 'advisor', 士: 'advisor', 帅: 'king', 将: 'king', 兵: 'pawn', 卒: 'pawn' };
function normalize(s: string): string {
  return s.normalize('NFKC').replace(/[一二三四五六七八九]/g, c => String('一二三四五六七八九'.indexOf(c) + 1))
    .replace(/車/g, '车').replace(/馬/g, '马').replace(/[砲]/g, '炮').replace(/進/g, '进').replace(/後/g, '后').replace(/帥/g, '帅').replace(/將/g, '将');
}
export function parseChineseMove(p: Position, token: string): MoveInput {
  const text = normalize(token), m = /^([车马炮相象仕士帅将兵卒])([1-9])(平|进|退)([1-9])$/.exec(text);
  const front = /^(前|后|中)([车马炮相象仕士帅将兵卒])(平|进|退)([1-9])$/.exec(text);
  if (!m && !front) throw new Error(`不支持的中文着法：${token}`);
  const kind = kinds[(m ?? front)![m ? 1 : 2]], action = (m ?? front)![3], number = +(m ?? front)![4];
  const file = (x: number) => p.next === 1 ? 9 - x : x + 1;
  let pieces = p.board.filter(x => x?.color === p.next && x.kind === kind).map(x => x!);
  if (m) pieces = pieces.filter(x => file(x.x) === +m[2]);
  else {
    const stacked = pieces.filter(x => pieces.some(y => x.id !== y.id && x.x === y.x));
    if (!stacked.length || new Set(stacked.map(x => x.x)).size !== 1) throw new Error(`前后子有歧义：${token}`);
    stacked.sort((a, b) => p.next === 1 ? a.y - b.y : b.y - a.y);
    pieces = front![1] === '前' ? [stacked[0]] : front![1] === '后' ? [stacked.at(-1)!] : stacked.length % 2 === 1 ? [stacked[Math.floor(stacked.length / 2)]] : [];
  }
  const ids = new Set(pieces.map(x => x.id));
  const matches = legalMoves(p).filter(move => {
    const piece = at(p.board, move.from)!; if (!ids.has(piece.id)) return false;
    if (action === '平') return move.from.y === move.to.y && file(move.to.x) === number;
    const forward = p.next === 1 ? move.from.y - move.to.y : move.to.y - move.from.y;
    if (action === '进' ? forward <= 0 : forward >= 0) return false;
    return ['horse', 'elephant', 'advisor'].includes(kind) ? file(move.to.x) === number : move.to.x === move.from.x && Math.abs(forward) === number;
  });
  if (matches.length !== 1) throw new Error(`非法或有歧义的着法：${token} (${matches.length} 个匹配)`);
  return matches[0];
}
export function parseOpeningPgn(text: string, plies = 20): { moves: MoveInput[]; ecco: string; title: string } {
  const headers = Object.fromEntries([...text.matchAll(/^\[(\w+)\s+"([^"\n]*)"\]\s*$/gm)].map(x => [x[1], x[2]]));
  if (headers.FEN !== 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1') throw new Error('只接收标准初始阵型开局');
  const body = text.replace(/^\[[^\n]*\]\s*$/gm, '').replace(/\{[^}]*\}/gs, '').replace(/;[^\n]*/g, '');
  if (/[()]/.test(body)) throw new Error('不自动选择嵌套变例');
  const tokens = body.replace(/\d+\.(?:\.\.)?/g, ' ').trim().split(/\s+/).filter(x => x && !['*', '1-0', '0-1', '1/2-1/2'].includes(x));
  let p = emptyPosition(); const moves: MoveInput[] = [];
  for (const token of tokens.slice(0, plies)) { const move = parseChineseMove(p, token); p = play(p, move); moves.push(move); }
  if (moves.length < 8) throw new Error('有效开局不足8半回合');
  return { moves, ecco: /^[A-E]\d\d$/.test(headers.ECCO ?? '') ? headers.ECCO : '', title: (headers.Event ?? 'CCPD开局示例').slice(0, 100) };
}
