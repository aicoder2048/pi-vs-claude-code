import type { Color, Point, Position } from '../business/engine';

// Coordinates are in the board's 900 × 1000 SVG viewBox, not CSS pixels.
// The dashed arrow is a displacement guide, not a legal movement trajectory.
export function lastMoveHighlight(position: Pick<Position, 'moves'>, human: Color, flipped = false, reviewing = false) {
  const move = position.moves.at(-1);
  if (!move) return null;
  const project = (p: Point): Point => ({ x: 50 + (flipped ? 8 - p.x : p.x) * 100, y: 50 + (flipped ? 9 - p.y : p.y) * 100 });
  const from = project(move.from), to = project(move.to);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const dx = (to.x - from.x) / distance, dy = (to.y - from.y) / distance;
  // Keep the line outside both the origin label and the destination piece.
  const start = { x: from.x + dx * 30, y: from.y + dy * 30 };
  const end = { x: to.x - dx * 56, y: to.y - dy * 56 };
  return { from, to, path: `M${start.x} ${start.y} L${end.x} ${end.y}`,
    caption: `${reviewing ? '回看此步' : '最近一步'} · ${move.color === human ? '你' : 'LLM'} · ${move.notation} · 第 ${position.moves.length} 手` };
}
