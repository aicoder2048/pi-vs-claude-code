export const SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];
export const inside = (row, col) =>
  row >= 0 && row < SIZE && col >= 0 && col < SIZE;
export const indexOf = (row, col) => row * SIZE + col;
export const other = (color) => (color === BLACK ? WHITE : BLACK);

export function winningLine(board, row, col) {
  const color = board[indexOf(row, col)];
  if (!color) return null;
  for (const [dr, dc] of DIRECTIONS) {
    const line = [[row, col]];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inside(r, c) && board[indexOf(r, c)] === color) {
        if (sign < 0) line.unshift([r, c]);
        else line.push([r, c]);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

export function createGame() {
  return {
    board: Array(SIZE * SIZE).fill(EMPTY),
    moves: [],
    turn: BLACK,
    winner: null,
    line: null,
    draw: false,
  };
}

export function play(game, row, col) {
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    !inside(row, col) ||
    game.winner ||
    game.draw ||
    game.board[indexOf(row, col)]
  )
    return false;
  const color = game.turn;
  game.board[indexOf(row, col)] = color;
  game.moves.push({ row, col, color });
  game.line = winningLine(game.board, row, col);
  game.winner = game.line ? color : null;
  game.draw = !game.winner && game.moves.length === SIZE * SIZE;
  game.turn = other(color);
  return true;
}

export function replay(moves) {
  if (!Array.isArray(moves) || moves.length > SIZE * SIZE)
    throw new Error("Invalid moves");
  const game = createGame();
  for (const move of moves) {
    if (!move || move.color !== game.turn || !play(game, move.row, move.col))
      throw new Error("Invalid move");
  }
  return game;
}

// Remove the player's most recent move and any AI reply, never the AI opening alone.
export function undoRound(game, humanColor) {
  const lastHuman = game.moves.findLastIndex(
    (move) => move.color === humanColor,
  );
  return lastHuman < 0 ? game : replay(game.moves.slice(0, lastHuman));
}
