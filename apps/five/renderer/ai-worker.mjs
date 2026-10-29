import { chooseMove } from "../src/ai.mjs";

self.onmessage = ({ data }) => {
  try {
    self.postMessage({
      id: data.id,
      move: chooseMove(data.board, data.color, data.level),
    });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
