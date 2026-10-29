import test from "node:test";
import assert from "node:assert/strict";
import { chooseMove, placementScore } from "../src/ai.mjs";
import { SIZE, BLACK, WHITE, indexOf, createGame, play } from "../src/game.mjs";

function position(black = [], white = []) {
  const board = Array(SIZE * SIZE).fill(0);
  black.forEach(([r, c]) => {
    board[indexOf(r, c)] = BLACK;
  });
  white.forEach(([r, c]) => {
    board[indexOf(r, c)] = WHITE;
  });
  return board;
}

for (const level of ["easy", "medium", "hard"]) {
  test(`${level}: opens in center, returns legal move without mutating input`, () => {
    const board = position();
    assert.deepEqual(chooseMove(board, BLACK, level), { row: 7, col: 7 });
    board[indexOf(7, 7)] = BLACK;
    const original = [...board];
    const move = chooseMove(board, WHITE, level, {
      budget: 80,
      random: () => 0.5,
    });
    assert.equal(board[indexOf(move.row, move.col)], 0);
    assert.deepEqual(board, original);
  });

  test(`${level}: takes a winning move before blocking opponent`, () => {
    const board = position(
      [
        [7, 3],
        [7, 4],
        [7, 5],
        [7, 6],
      ],
      [
        [9, 3],
        [9, 4],
        [9, 5],
        [9, 6],
      ],
    );
    const move = chooseMove(board, BLACK, level);
    assert.equal(move.row, 7);
    assert.ok([2, 7].includes(move.col));
  });

  test(`${level}: blocks immediate four and broken four at board edge`, () => {
    for (const cols of [
      [0, 1, 2, 3],
      [0, 1, 3, 4],
    ]) {
      const board = position(
        cols.map((col) => [0, col]),
        [[7, 7]],
      );
      const move = chooseMove(board, WHITE, level);
      assert.deepEqual(move, { row: 0, col: cols.includes(2) ? 4 : 2 });
    }
  });

  test(`${level}: recognizes a diagonal winning gap`, () => {
    const board = position(
      [
        [0, 0],
        [1, 1],
        [3, 3],
        [4, 4],
      ],
      [[8, 8]],
    );
    assert.deepEqual(chooseMove(board, BLACK, level), { row: 2, col: 2 });
  });
}

test("open four outranks an open three; double-three threat outranks a single three", () => {
  const four = position([
    [7, 5],
    [7, 6],
    [7, 8],
  ]);
  const three = position([
    [7, 6],
    [7, 8],
  ]);
  const double = position([
    [7, 6],
    [7, 8],
    [6, 7],
    [8, 7],
  ]);
  assert.ok(
    placementScore(four, 7, 7, BLACK) > placementScore(three, 7, 7, BLACK),
  );
  assert.ok(
    placementScore(double, 7, 7, BLACK) > placementScore(three, 7, 7, BLACK),
  );
});

test("easy difficulty offers variation and hard timeouts retain a legal fallback", () => {
  const board = position([[7, 7]], [[8, 8]]);
  assert.notDeepEqual(
    chooseMove(board, BLACK, "easy", { random: () => 0 }),
    chooseMove(board, BLACK, "easy", { random: () => 0.99 }),
  );
  let time = 0;
  const original = [...board];
  const move = chooseMove(board, BLACK, "hard", {
    now: () => time++,
    budget: 5,
  });
  assert.equal(board[indexOf(move.row, move.col)], 0);
  assert.deepEqual(board, original);
});

test("full board has no move", () => {
  assert.equal(chooseMove(Array(SIZE * SIZE).fill(BLACK), WHITE), null);
});

test("AI self-play produces legal games for all three levels", () => {
  for (const level of ["easy", "medium", "hard"]) {
    const game = createGame();
    for (let n = 0; n < 24 && !game.winner && !game.draw; n++) {
      const move = chooseMove(game.board, game.turn, level, {
        budget: 15,
        random: () => 0.3,
      });
      assert.ok(move);
      assert.ok(
        play(game, move.row, move.col),
        `${level}: illegal move at turn ${n}`,
      );
    }
  }
});
