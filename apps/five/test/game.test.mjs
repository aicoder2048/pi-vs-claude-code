import test from "node:test";
import assert from "node:assert/strict";
import {
  SIZE,
  BLACK,
  WHITE,
  createGame,
  play,
  replay,
  winningLine,
  undoRound,
  indexOf,
} from "../src/game.mjs";

function boardOf(cells, color = BLACK) {
  const board = Array(SIZE * SIZE).fill(0);
  for (const [r, c] of cells) board[indexOf(r, c)] = color;
  return board;
}

test("15×15 board starts empty, black first; turns alternate", () => {
  const game = createGame();
  assert.equal(game.board.length, 225);
  assert.ok(game.board.every((cell) => cell === 0));
  assert.equal(game.turn, BLACK);
  assert.ok(play(game, 7, 7));
  assert.equal(game.turn, WHITE);
  assert.ok(play(game, 8, 8));
  assert.equal(game.turn, BLACK);
  assert.deepEqual(
    game.moves.map((m) => m.color),
    [BLACK, WHITE],
  );
});

test("occupied, fractional and out-of-bounds moves leave the state untouched", () => {
  const game = createGame();
  play(game, 7, 7);
  const before = structuredClone(game);
  for (const [r, c] of [
    [7, 7],
    [-1, 0],
    [15, 5],
    [7, 15],
    [1.5, 2],
    [NaN, 3],
    [2, undefined],
  ]) {
    assert.equal(play(game, r, c), false);
    assert.deepEqual(game, before);
  }
});

for (const [name, dr, dc] of [
  ["horizontal", 0, 1],
  ["vertical", 1, 0],
  ["diagonal", 1, 1],
  ["anti-diagonal", 1, -1],
]) {
  test(`detects ${name} five, including edge positions`, () => {
    const cells = Array.from({ length: 5 }, (_, i) => [i * dr, 7 + i * dc]);
    const board = boardOf(cells);
    assert.equal(winningLine(board, ...cells[2]).length, 5);
    board[indexOf(...cells[0])] = WHITE;
    assert.equal(winningLine(board, ...cells[2]), null);
  });
}

test("overlines win; rows do not wrap around board boundaries", () => {
  const cells = Array.from({ length: 6 }, (_, c) => [5, c]);
  assert.equal(winningLine(boardOf(cells), 5, 3).length, 6);
  assert.equal(
    winningLine(
      boardOf([
        [0, 13],
        [0, 14],
        [1, 0],
        [1, 1],
        [1, 2],
      ]),
      1,
      1,
    ),
    null,
  );
});

test("play records winner and rejects all further moves", () => {
  const game = createGame();
  for (let i = 0; i < 4; i++) {
    play(game, 0, i);
    play(game, 2, i);
  }
  play(game, 0, 4);
  assert.equal(game.winner, BLACK);
  assert.equal(game.line.length, 5);
  assert.equal(game.draw, false);
  assert.equal(play(game, 2, 4), false);
});

test("a full board without a five ends in a draw", () => {
  // Two-color pattern with all runs shorter than five in all four directions.
  const black = [],
    white = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      ((r + 2 * c) % 4 < 2 ? black : white).push([r, c]);
    }
  const game = createGame();
  while (black.length || white.length) {
    const next = (game.turn === BLACK ? black : white).pop();
    assert.ok(next);
    assert.ok(play(game, ...next));
  }
  assert.equal(game.winner, null);
  assert.equal(game.draw, true);
  assert.equal(game.moves.length, 225);
});

test("undo removes human move and AI reply; preserves AI opening", () => {
  const blackGame = createGame();
  play(blackGame, 7, 7);
  play(blackGame, 8, 7);
  assert.equal(undoRound(blackGame, BLACK).moves.length, 0);
  const whiteGame = createGame();
  play(whiteGame, 7, 7);
  assert.equal(undoRound(whiteGame, WHITE), whiteGame);
  play(whiteGame, 6, 6);
  play(whiteGame, 8, 8);
  const undone = undoRound(whiteGame, WHITE);
  assert.equal(undone.moves.length, 1);
  assert.equal(undone.turn, WHITE);
});

test("undo while AI is thinking removes just the human move; undo clears winner", () => {
  const game = createGame();
  play(game, 7, 7);
  assert.equal(undoRound(game, BLACK).moves.length, 0);
  const won = createGame();
  for (let i = 0; i < 4; i++) {
    play(won, 0, i);
    play(won, 2, i);
  }
  play(won, 0, 4);
  const undone = undoRound(won, BLACK);
  assert.equal(undone.winner, null);
  assert.equal(undone.turn, BLACK);
});

test("saved games replay exactly; malformed or post-win histories are rejected", () => {
  const game = createGame();
  play(game, 7, 7);
  play(game, 7, 8);
  assert.deepEqual(replay(JSON.parse(JSON.stringify(game.moves))), game);
  for (const bad of [
    null,
    {},
    [null],
    [{ row: 7, col: 7, color: WHITE }],
    [game.moves[0], game.moves[0]],
  ])
    assert.throws(() => replay(bad));
  const moves = [];
  for (let i = 0; i < 5; i++) {
    moves.push({ row: 0, col: i, color: BLACK });
    if (i < 4) moves.push({ row: 2, col: i, color: WHITE });
  }
  assert.throws(() => replay([...moves, { row: 8, col: 8, color: WHITE }]));
});
