// Bounded continuous-four refutation, NOT a move selector or a general solver.
// Five-cell windows cover every freestyle five (including broken fours/overlines).
import { DIRECTIONS, SIZE, coordinate, index, other, play, type Color, type Point, type Position } from './rules';

export interface ForcingBudget { maxAttackMoves: number; maxNodes: number; maxMs: number }
export const DEFAULT_FORCING_BUDGET: Readonly<ForcingBudget> = { maxAttackMoves: 3, maxNodes: 6000, maxMs: 200 };
export interface ForcingProof {
  attacker: Color;
  line: Point[];
  terminal: 'five' | 'two-winning-points';
  winningPoints: Point[];
}
export interface ForcingCheck {
  candidate: string;
  status: 'found-forced-loss' | 'not-found-within-budget' | 'incomplete';
  reason: 'continuous-four' | 'candidate-wins' | 'candidate-draw' | 'depth-exhausted' | 'node-budget' | 'time-budget' | 'aborted' | 'clock-budget';
  scope: 'opponent-continuous-four-only';
  budget: ForcingBudget;
  nodes: number;
  elapsedMs: number;
  proof?: ForcingProof;
}
export interface ForcingOptions extends Partial<ForcingBudget> { signal?: AbortSignal; now?: () => number }
const windows: number[][] = [], through = Array.from({ length: SIZE * SIZE }, () => [] as number[]);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) for (const [dx, dy] of DIRECTIONS) {
  if (x + dx * 4 < 0 || x + dx * 4 >= SIZE || y + dy * 4 < 0 || y + dy * 4 >= SIZE) continue;
  const line = Array.from({ length: 5 }, (_, k) => index(x + dx * k, y + dy * k));
  const id = windows.push(line) - 1;
  for (const p of line) through[p].push(id);
}
const point = (p: number): Point => ({ x: p % SIZE, y: Math.floor(p / SIZE) });

export async function checkForcingSequences(position: Position, candidate: Point, options: ForcingOptions = {}): Promise<ForcingCheck> {
  const after = play(position, candidate); // authoritative legality; never mutate the caller
  const budget: ForcingBudget = {
    maxAttackMoves: options.maxAttackMoves ?? DEFAULT_FORCING_BUDGET.maxAttackMoves,
    maxNodes: options.maxNodes ?? DEFAULT_FORCING_BUDGET.maxNodes,
    maxMs: options.maxMs ?? DEFAULT_FORCING_BUDGET.maxMs,
  };
  for (const [key, max] of [['maxAttackMoves', 4], ['maxNodes', 20_000], ['maxMs', 500]] as const) {
    if (!Number.isInteger(budget[key]) || budget[key] < (key === 'maxAttackMoves' ? 1 : 0) || budget[key] > max) throw new Error(`无效的战术预算：${key}`);
  }
  const now = options.now ?? (() => performance.now()), started = now();
  let nodes = 0, nextYield = 32, stop: ForcingCheck['reason'] | undefined;
  const finish = (status: ForcingCheck['status'], reason: ForcingCheck['reason'], proof?: ForcingProof): ForcingCheck => ({
    candidate: coordinate(candidate), status, reason, scope: 'opponent-continuous-four-only', budget, nodes,
    elapsedMs: Math.max(0, now() - started), ...(proof ? { proof } : {}),
  });
  if (options.signal?.aborted) return finish('incomplete', 'aborted');
  if (after.winner) return finish('not-found-within-budget', after.winner === 'draw' ? 'candidate-draw' : 'candidate-wins');

  const board = after.board.slice(), counts = [new Uint8Array(windows.length), new Uint8Array(windows.length), new Uint8Array(windows.length)];
  for (let w = 0; w < windows.length; w++) for (const p of windows[w]) counts[board[p]][w]++;
  const set = (p: number, color: 0 | Color) => {
    const previous = board[p]; board[p] = color;
    for (const w of through[p]) { counts[previous][w]--; counts[color][w]++; }
  };
  const wins = (color: Color): number[] => {
    const found = new Set<number>();
    for (let w = 0; w < windows.length; w++) if (counts[color][w] === 4 && counts[0][w] === 1) {
      found.add(windows[w].find(p => board[p] === 0)!);
    }
    return [...found].sort((a, b) => a - b);
  };
  const withinBudget = () => {
    if (stop) return false;
    if (options.signal?.aborted) stop = 'aborted';
    else if (nodes >= budget.maxNodes) stop = 'node-budget';
    else if (now() - started >= budget.maxMs) stop = 'time-budget';
    return !stop;
  };
  const attacker = after.next, defender = other(attacker);
  const search = async (depth: number): Promise<ForcingProof | undefined> => {
    if (!withinBudget()) return;
    nodes++;
    const direct = wins(attacker);
    if (direct.length) return { attacker, line: [point(direct[0])], terminal: 'five', winningPoints: [point(direct[0])] };
    if (depth === 0) return;
    const mustBlock = wins(defender);
    if (mustBlock.length > 1) return; // defender wins first; no continuous-four proof
    const moves = new Set<number>(mustBlock);
    if (!mustBlock.length) {
      // Exact generation, not heuristic pruning: any move making a four must
      // complete a five-cell window currently holding 3 attacker stones + 2 empties.
      for (let w = 0; w < windows.length; w++) if (counts[attacker][w] === 3 && counts[0][w] === 2) {
        for (const p of windows[w]) if (!board[p]) moves.add(p);
      }
    }
    for (const move of [...moves].sort((a, b) => a - b)) {
      // Yield so cancellation, authoritative clock ticks and UI/IPC can run.
      if (nodes >= nextYield) {
        nextYield = nodes + 32;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (!withinBudget()) return;
      nodes++; set(move, attacker);
      const threats = wins(attacker), counterWins = wins(defender);
      let proof: ForcingProof | undefined;
      if (threats.length && !counterWins.length) {
        if (threats.length > 1) {
          proof = { attacker, line: [point(move)], terminal: 'two-winning-points', winningPoints: threats.map(point) };
        } else {
          // With no immediate counter-win, blocking this single point is the
          // ONLY reply that does not lose next move. All other replies are covered.
          const reply = threats[0]; set(reply, defender);
          const tail = await search(depth - 1);
          set(reply, 0);
          if (tail) proof = { ...tail, line: [point(move), point(reply), ...tail.line] };
        }
      }
      set(move, 0);
      if (stop) return;
      if (proof) return proof;
    }
  };
  // Let pending cancel/deadline events run even for searches smaller than 32 nodes.
  if (withinBudget()) await new Promise<void>(resolve => setTimeout(resolve, 0));
  const proof = await search(budget.maxAttackMoves);
  if (stop) return finish('incomplete', stop);
  // A proof found after the deadline must not be advertised as a completed check.
  if (options.signal?.aborted || now() - started >= budget.maxMs) return finish('incomplete', options.signal?.aborted ? 'aborted' : 'time-budget');
  return proof ? finish('found-forced-loss', 'continuous-four', proof) : finish('not-found-within-budget', 'depth-exhausted');
}
