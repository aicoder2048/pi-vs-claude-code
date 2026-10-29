import {
  SIZE,
  DIRECTIONS,
  inside,
  indexOf,
  other,
  winningLine,
} from "./game.mjs";

const FIVE = 1_000_000;
const WIN = 1_000_000_000;
const LEVELS = {
  easy: { depth: 1, width: 8, budget: 120 },
  medium: { depth: 2, width: 10, budget: 450 },
  hard: { depth: 4, width: 8, budget: 1400 },
};

// Score only threats involving this stone. O is an opponent or a board edge.
export function placementScore(board, row, col, color) {
  let total = 0;
  let openThrees = 0;
  let fours = 0;
  for (const [dr, dc] of DIRECTIONS) {
    let line = "";
    for (let k = -5; k <= 5; k++) {
      const r = row + dr * k;
      const c = col + dc * k;
      const value = inside(r, c) ? board[indexOf(r, c)] : -1;
      line += k === 0 || value === color ? "X" : value === 0 ? "." : "O";
    }
    // Restrict every matched pattern to those containing the proposed move (index 5).
    const has = (pattern) => {
      let start = line.indexOf(pattern);
      while (start !== -1) {
        if (
          start <= 5 &&
          start + pattern.length > 5 &&
          pattern[5 - start] === "X"
        )
          return true;
        start = line.indexOf(pattern, start + 1);
      }
      return false;
    };
    if (has("XXXXX")) return FIVE;
    if (has(".XXXX.")) {
      total += 100_000;
      fours++;
    } else if (["XXXX.", ".XXXX", "XXX.X", "XX.XX", "X.XXX"].some(has)) {
      total += 16_000;
      fours++;
    } else if ([".XXX.", ".XX.X.", ".X.XX."].some(has)) {
      total += 7_000;
      openThrees++;
    } else if (
      [
        "XXX..",
        "..XXX",
        "XX.X.",
        ".X.XX",
        "X.XX.",
        ".XX.X",
        "XX..X",
        "X..XX",
        "X.X.X",
      ].some(has)
    )
      total += 700;
    else if ([".XX.", ".X.X."].some(has)) total += 180;
    else if (["XX...", "...XX", "X.X..", "..X.X"].some(has)) total += 35;
    else total += 3;
  }
  if (fours >= 2) total += 100_000;
  if (fours && openThrees) total += 60_000;
  if (openThrees >= 2) total += 35_000;
  return total;
}

function candidates(board, color, width) {
  const nearby = new Set();
  for (let i = 0; i < board.length; i++) {
    if (!board[i]) continue;
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    for (let dr = -2; dr <= 2; dr++)
      for (let dc = -2; dc <= 2; dc++) {
        if (inside(r + dr, c + dc)) {
          const at = indexOf(r + dr, c + dc);
          if (!board[at]) nearby.add(at);
        }
      }
  }
  if (!nearby.size)
    return board.some(Boolean)
      ? []
      : [{ row: 7, col: 7, attack: 0, defense: 0, score: 0 }];
  const scored = [...nearby]
    .map((at) => {
      const row = Math.floor(at / SIZE);
      const col = at % SIZE;
      const attack = placementScore(board, row, col, color);
      const defense = placementScore(board, row, col, other(color));
      const centrality = 14 - Math.abs(row - 7) - Math.abs(col - 7);
      return {
        row,
        col,
        attack,
        defense,
        score: attack + defense * 0.95 + centrality,
      };
    })
    .sort((a, b) => b.score - a.score);
  const wins = scored.filter((m) => m.attack >= FIVE);
  if (wins.length) return wins;
  const blocks = scored.filter((m) => m.defense >= FIVE);
  return blocks.length ? blocks : scored.slice(0, width);
}

function evaluate(board, color) {
  const ours = candidates(board, color, 3);
  const theirs = candidates(board, other(color), 3);
  const threatValue = (moves) => {
    const scores = moves.map((m) => m.attack).sort((a, b) => b - a);
    return (scores[0] || 0) + (scores[1] || 0) * 0.3 + (scores[2] || 0) * 0.1;
  };
  return threatValue(ours) - threatValue(theirs) * 0.93;
}

export function chooseMove(
  input,
  color,
  level = "medium",
  { random = Math.random, now = () => performance.now(), budget } = {},
) {
  const board = Array.from(input);
  if (board.length !== SIZE * SIZE || ![1, 2].includes(color))
    throw new Error("Invalid position");
  const settings = LEVELS[level] || LEVELS.medium;
  const root = candidates(board, color, settings.width);
  if (!root.length) return null;
  const result = (move) => ({ row: move.row, col: move.col });
  if (root[0].attack >= FIVE || root[0].defense >= FIVE || !board.some(Boolean))
    return result(root[0]);
  if (level === "easy") {
    // Relaxed play: sample among plausible moves, but never miss an immediate win/block.
    const choices = root.slice(0, 4);
    return result(
      choices[
        Math.min(choices.length - 1, Math.floor(random() * choices.length))
      ],
    );
  }
  const deadline = now() + (budget ?? settings.budget);
  const timeout = Symbol("timeout");
  function search(turn, depth, alpha, beta, ply) {
    if (now() >= deadline) throw timeout;
    if (!depth) return evaluate(board, turn);
    const options = candidates(board, turn, settings.width);
    if (!options.length) return 0;
    let best = -Infinity;
    for (const move of options) {
      const at = indexOf(move.row, move.col);
      board[at] = turn;
      let value;
      try {
        value = winningLine(board, move.row, move.col)
          ? WIN - ply
          : -search(other(turn), depth - 1, -beta, -alpha, ply + 1);
      } finally {
        board[at] = 0;
      }
      best = Math.max(best, value);
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return best;
  }
  let bestMove = root[0];
  // Keep the last completed iteration if the time budget expires.
  for (let depth = 1; depth <= settings.depth; depth++) {
    let iterationBest = root[0];
    let bestValue = -Infinity;
    try {
      for (const move of root) {
        if (now() >= deadline) throw timeout;
        const at = indexOf(move.row, move.col);
        board[at] = color;
        let value;
        try {
          value = winningLine(board, move.row, move.col)
            ? WIN
            : -search(other(color), depth - 1, -Infinity, -bestValue, 1);
        } finally {
          board[at] = 0;
        }
        if (value > bestValue) {
          bestValue = value;
          iterationBest = move;
        }
      }
      bestMove = iterationBest;
      if (bestValue > WIN / 2) break;
      root.sort((a, b) => Number(b === bestMove) - Number(a === bestMove));
    } catch (error) {
      if (error !== timeout) throw error;
      break;
    }
  }
  return result(bestMove);
}
