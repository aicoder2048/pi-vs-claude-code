import type { MoveInput } from '../../src/business/engine';

// f387e992-7ce6-4e23-bc81-5b1ba4a865e3: red forks both horses
// on ply 33; black then spends all eight requests without submitting a move.
export const REQUEST_BUDGET_GAME: MoveInput[] = [
  [7,7,4,7], [1,0,2,2], [7,9,6,7], [7,2,5,2],
  [8,9,7,9], [0,0,0,1], [1,7,2,7], [5,2,5,3],
  [7,9,7,4], [7,0,6,2], [6,6,6,5], [1,2,1,8],
  [7,4,1,4], [1,8,6,8], [6,7,5,5], [8,0,8,1],
  [0,9,0,8], [6,8,6,6], [5,5,3,4], [2,2,4,1],
  [3,4,5,3], [4,1,5,3], [2,7,2,3], [5,3,6,5],
  [1,9,2,7], [6,6,2,6], [3,9,4,8], [2,6,8,6],
  [2,7,3,5], [8,6,8,8], [0,8,0,7], [6,5,4,6],
  [3,5,5,4],
].map(([x, y, tx, ty]) => ({ from: { x: x!, y: y! }, to: { x: tx!, y: ty! } }));
