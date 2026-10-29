import {
  SIZE,
  BLACK,
  WHITE,
  createGame,
  play,
  replay,
  undoRound,
  inside,
  indexOf,
  other,
} from "../src/game.mjs";
import { AudioEngine } from "./audio.mjs";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#board");
const ctx = canvas.getContext("2d");
const STORAGE_KEY = "five.game.v1";
const SETTINGS_KEY = "five.settings.v1";
const levelText = {
  easy: ["入门 · 轻松一局", "轻松的启发式落子，适合熟悉棋盘。"],
  medium: ["进阶 · 从容应战", "攻守兼备，提前推演对手的下一步。"],
  hard: ["高手 · 步步为营", "更深层的限时搜索，寻找进攻与防守的平衡。"],
};
let game = createGame();
let config = { humanColor: BLACK, level: "medium" };
let preferences = { sound: true, numbers: false, music: "off", volume: 30 };
let thinking = false;
let worker = null;
let timer = null;
let watchdog = null;
let generation = 0;
let hover = null;
let keyboardCell = [7, 7];
let keyboardMode = false;
let pendingConfig = null;
let lastPlacedAt = 0;
let storageAvailable = true;
let toastTimer;
let size = 600;
let texture;
let textureSize = 0;
const audio = new AudioEngine();

function loadSaved() {
  try {
    const savedPreferences = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) || "null",
    );
    if (savedPreferences) {
      if (typeof savedPreferences.sound === "boolean")
        preferences.sound = savedPreferences.sound;
      if (typeof savedPreferences.numbers === "boolean")
        preferences.numbers = savedPreferences.numbers;
      if (["off", "piano", "jazz"].includes(savedPreferences.music))
        preferences.music = savedPreferences.music;
      if (Number.isFinite(savedPreferences.volume))
        preferences.volume = Math.max(
          0,
          Math.min(100, savedPreferences.volume),
        );
    }
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (
      saved &&
      [BLACK, WHITE].includes(saved.humanColor) &&
      Object.hasOwn(levelText, saved.level)
    ) {
      game = replay(saved.moves);
      config = { humanColor: saved.humanColor, level: saved.level };
    }
  } catch {
    game = createGame();
    notify("未能读取上次棋局，已为你开启新局。");
  }
}

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...config, moves: game.moves }),
    );
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences));
  } catch {
    storageAvailable = false;
    $("#save-status").textContent = "本机存储不可用，关闭后棋局不会保留";
  }
}

function notify(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3200);
}

function cancelAI() {
  generation++;
  clearTimeout(timer);
  clearTimeout(watchdog);
  worker?.terminate();
  worker = null;
  thinking = false;
}

function fallbackMove() {
  // A worker failure must not strand a game. Retry is possible on the next turn.
  const empties = game.board
    .map((value, i) => (value ? -1 : i))
    .filter((i) => i !== -1);
  empties.sort(
    (a, b) =>
      Math.abs(Math.floor(a / SIZE) - 7) +
      Math.abs((a % SIZE) - 7) -
      Math.abs(Math.floor(b / SIZE) - 7) -
      Math.abs((b % SIZE) - 7),
  );
  const at = empties[0];
  return at === undefined
    ? null
    : { row: Math.floor(at / SIZE), col: at % SIZE };
}

function startAI() {
  if (game.winner || game.draw || game.turn === config.humanColor) return;
  cancelAI();
  thinking = true;
  hover = null;
  const id = generation;
  const started = performance.now();
  updateUI();
  draw();
  const finish = (move, failed = false) => {
    if (id !== generation) return;
    clearTimeout(watchdog);
    worker?.terminate();
    worker = null;
    const delay = Math.max(0, 420 - (performance.now() - started));
    timer = setTimeout(() => {
      if (id !== generation) return;
      thinking = false;
      const valid =
        move &&
        Number.isInteger(move.row) &&
        Number.isInteger(move.col) &&
        inside(move.row, move.col) &&
        !game.board[indexOf(move.row, move.col)];
      const chosen = valid ? move : fallbackMove();
      if (chosen) place(chosen.row, chosen.col);
      else updateUI();
      if (failed || !valid) notify("AI 计算暂时异常，本手已使用备用落子。");
    }, delay);
  };
  try {
    worker = new Worker(new URL("./ai-worker.mjs", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      if (data.id === id) finish(data.move, Boolean(data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(null, true);
    };
    worker.postMessage({
      id,
      board: game.board,
      color: game.turn,
      level: config.level,
    });
    watchdog = setTimeout(() => finish(null, true), 6000);
  } catch {
    finish(null, true);
  }
}

function place(row, col) {
  if (!play(game, row, col)) return false;
  lastPlacedAt = performance.now();
  hover = null;
  keyboardCell = [row, col];
  if (preferences.sound) audio.stone();
  save();
  updateUI();
  animatePlacement();
  return true;
}

function humanMove(row, col) {
  if (thinking || game.turn !== config.humanColor || $("#confirm-dialog").open)
    return;
  audio.unlock();
  if (place(row, col)) startAI();
}

function updateUI() {
  const ended = Boolean(game.winner || game.draw);
  const humanWon = game.winner === config.humanColor;
  const ourTurn = game.turn === config.humanColor;
  $("#status-title").textContent = ended
    ? game.draw
      ? "不分伯仲"
      : humanWon
        ? "这一局，你赢了"
        : "再弈一局？"
    : thinking
      ? "拾伍思考中"
      : "轮到你了";
  $("#status-detail").textContent = ended
    ? game.draw
      ? "棋盘已满，握手言和。"
      : humanWon
        ? "五子连珠，好棋！棋逢对手最是难得。"
        : "胜负之外，还有下一手的风景。"
    : thinking
      ? "静候片刻，好棋值得思量…"
      : game.moves.length === 0
        ? "执黑先行，开启这一局。"
        : "不急，找到你的下一步。";
  $("#game-badge").textContent = ended
    ? "已结束"
    : thinking
      ? "思考中"
      : "进行中";
  $("#turn-stone").className =
    `stone ${(game.winner || game.turn) === BLACK ? "black" : "white"}`;
  $(".status-card").classList.toggle("thinking", thinking);
  $("#human-player").classList.toggle("active", ended ? humanWon : ourTurn);
  $("#ai-player").classList.toggle(
    "active",
    ended ? !humanWon && !game.draw : !ourTurn,
  );
  $("#human-color").textContent =
    config.humanColor === BLACK ? "黑棋 · 先手" : "白棋 · 后手";
  $("#human-player .player-dot").className =
    `player-dot ${config.humanColor === BLACK ? "black" : "white"}`;
  $("#ai-color-dot").className =
    `player-dot ${config.humanColor === BLACK ? "white" : "black"}`;
  $("#ai-level").textContent = levelText[config.level][0];
  $("#difficulty-detail").textContent = levelText[config.level][1];
  document
    .querySelectorAll("[data-level]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.level === config.level),
      ),
    );
  document
    .querySelectorAll("[data-color]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.color) === config.humanColor),
      ),
    );
  $("#undo").disabled = !game.moves.some(
    (move) => move.color === config.humanColor,
  );
  $("#numbers").checked = preferences.numbers;
  $("#sound").setAttribute("aria-pressed", String(preferences.sound));
  $("#sound").setAttribute(
    "aria-label",
    preferences.sound ? "关闭落子音效" : "开启落子音效",
  );
  $("#move-count").textContent =
    `第 ${String(game.moves.length).padStart(2, "0")} 手`;
  const last = game.moves.at(-1);
  $("#last-move").textContent = last
    ? `${last.color === BLACK ? "黑" : "白"}棋落于 ${String.fromCharCode(65 + last.col)}${SIZE - last.row}${ended ? " · 对局结束" : ""}`
    : "黑棋先行，落子无悔亦可悔";
  canvas.classList.toggle("busy", thinking);
  canvas.classList.toggle("finished", ended);
  canvas.setAttribute(
    "aria-label",
    `15乘15五子棋棋盘。${$("#status-title").textContent}。共${game.moves.length}手。方向键移动，回车或空格落子。`,
  );
}

function requestReset(changes = {}) {
  pendingConfig = { ...config, ...changes };
  if (game.moves.length && !game.winner && !game.draw) {
    $("#confirm-dialog").showModal();
    $("#cancel-reset").focus();
  } else reset();
}

function reset() {
  cancelAI();
  config = pendingConfig || config;
  pendingConfig = null;
  game = createGame();
  hover = null;
  keyboardCell = [7, 7];
  $("#confirm-dialog").close();
  save();
  updateUI();
  draw();
  startAI();
}

function undo() {
  const next = undoRound(game, config.humanColor);
  if (next === game) return;
  cancelAI();
  game = next;
  hover = null;
  keyboardCell = game.moves.length
    ? [game.moves.at(-1).row, game.moves.at(-1).col]
    : [7, 7];
  save();
  updateUI();
  draw();
  notify("已退回到你上一次落子前。");
}

const padding = () => size * 0.067;
const step = () => (size - padding() * 2) / (SIZE - 1);
const point = (row, col) => [
  padding() + col * step(),
  padding() + row * step(),
];

function makeTexture() {
  texture = document.createElement("canvas");
  texture.width = texture.height = Math.ceil(size);
  const t = texture.getContext("2d");
  const bg = t.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, "#e9cb93");
  bg.addColorStop(0.45, "#e2bf83");
  bg.addColorStop(1, "#dcba7e");
  t.fillStyle = bg;
  t.fillRect(0, 0, size, size);
  let seed = 49;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let y = 0; y < size; y += 1.7) {
    t.beginPath();
    t.strokeStyle = `rgba(131,88,39,${0.015 + random() * 0.045})`;
    t.lineWidth = random() * 0.7 + 0.3;
    t.moveTo(0, y);
    t.bezierCurveTo(
      size * 0.3,
      y + random() * 4,
      size * 0.7,
      y - random() * 4,
      size,
      y + random() * 2,
    );
    t.stroke();
  }
  textureSize = size;
}

function drawStone(
  row,
  col,
  color,
  { alpha = 1, scale = 1, number = null, last = false, winning = false } = {},
) {
  const [x, y] = point(row, col);
  const radius = step() * 0.438 * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "#3c260a70";
  ctx.shadowBlur = radius * 0.36;
  ctx.shadowOffsetY = radius * 0.17;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  const gradient = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.45,
    radius * 0.1,
    x,
    y,
    radius,
  );
  if (color === BLACK) {
    gradient.addColorStop(0, "#55564e");
    gradient.addColorStop(0.5, "#292b26");
    gradient.addColorStop(1, "#141610");
  } else {
    gradient.addColorStop(0, "#fffef8");
    gradient.addColorStop(0.6, "#f5f0e1");
    gradient.addColorStop(1, "#d0c7af");
  }
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  if (winning) {
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.86, 0, Math.PI * 2);
    ctx.strokeStyle = color === BLACK ? "#cab577" : "#6d8659";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (number !== null) {
    ctx.fillStyle = color === BLACK ? "#e4e4d7" : "#535447";
    ctx.font = `500 ${radius * 0.78}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(number), x, y + 0.5);
  } else if (last) {
    ctx.fillStyle = "#bd7456";
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, radius * 0.15), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function draw() {
  if (!size) return;
  ctx.clearRect(0, 0, size, size);
  if (!texture || textureSize !== size) makeTexture();
  ctx.drawImage(texture, 0, 0, size, size);
  const pad = padding();
  const gap = step();
  ctx.strokeStyle = "#795b36a6";
  ctx.lineWidth = Math.max(0.6, size / 850);
  for (let i = 0; i < SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(pad, pad + i * gap);
    ctx.lineTo(size - pad, pad + i * gap);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pad + i * gap, pad);
    ctx.lineTo(pad + i * gap, size - pad);
    ctx.stroke();
  }
  ctx.strokeStyle = "#70512fbb";
  ctx.lineWidth = 1.25;
  ctx.strokeRect(pad, pad, size - pad * 2, size - pad * 2);
  ctx.fillStyle = "#755533";
  for (const [r, c] of [
    [3, 3],
    [3, 11],
    [7, 7],
    [11, 3],
    [11, 11],
  ]) {
    const [x, y] = point(r, c);
    ctx.beginPath();
    ctx.arc(x, y, gap * 0.085, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = `${Math.max(9, size * 0.016)}px -apple-system,sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#856b44";
  for (let i = 0; i < SIZE; i++) {
    const at = pad + i * gap;
    ctx.fillText(String.fromCharCode(65 + i), at, pad * 0.43);
    ctx.fillText(String.fromCharCode(65 + i), at, size - pad * 0.4);
    ctx.fillText(String(SIZE - i), pad * 0.4, at);
    ctx.fillText(String(SIZE - i), size - pad * 0.4, at);
  }
  const progress = Math.min(1, (performance.now() - lastPlacedAt) / 160);
  const winningCells = new Set(
    (game.line || []).map(([r, c]) => indexOf(r, c)),
  );
  game.moves.forEach((move, i) => {
    const last = i === game.moves.length - 1;
    drawStone(move.row, move.col, move.color, {
      last,
      number: preferences.numbers ? i + 1 : null,
      scale: last ? 0.84 + 0.16 * (1 - (1 - progress) ** 3) : 1,
      winning: winningCells.has(indexOf(move.row, move.col)),
    });
  });
  const cursor =
    keyboardMode && document.activeElement === canvas ? keyboardCell : hover;
  if (
    cursor &&
    !thinking &&
    !game.winner &&
    !game.draw &&
    game.turn === config.humanColor
  ) {
    const [r, c] = cursor;
    if (!game.board[indexOf(r, c)])
      drawStone(r, c, config.humanColor, { alpha: 0.3 });
    if (keyboardMode) {
      const [x, y] = point(r, c);
      ctx.strokeStyle = "#44633e";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - gap * 0.47, y - gap * 0.47, gap * 0.94, gap * 0.94);
    }
  }
}

function animatePlacement() {
  draw();
  if (performance.now() - lastPlacedAt < 170)
    requestAnimationFrame(animatePlacement);
}

function resize() {
  size = canvas.getBoundingClientRect().width;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function cellFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const col = Math.round((x - padding()) / step());
  const row = Math.round((y - padding()) / step());
  return inside(row, col) &&
    Math.abs(x - point(row, col)[0]) < step() * 0.48 &&
    Math.abs(y - point(row, col)[1]) < step() * 0.48
    ? [row, col]
    : null;
}

canvas.addEventListener("pointermove", (event) => {
  keyboardMode = false;
  hover = cellFromEvent(event);
  draw();
});
canvas.addEventListener("pointerleave", () => {
  hover = null;
  draw();
});
canvas.addEventListener("click", (event) => {
  const cell = cellFromEvent(event);
  if (cell) humanMove(...cell);
});
canvas.addEventListener("focus", draw);
canvas.addEventListener("blur", draw);
canvas.addEventListener("keydown", (event) => {
  const keys = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  if (keys[event.key]) {
    event.preventDefault();
    keyboardMode = true;
    const delta = keys[event.key];
    keyboardCell = keyboardCell.map((value, i) =>
      Math.max(0, Math.min(SIZE - 1, value + delta[i])),
    );
    draw();
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    keyboardMode = true;
    humanMove(...keyboardCell);
  }
});
$("#new-game").addEventListener("click", () => requestReset());
$("#undo").addEventListener("click", undo);
$("#confirm-reset").addEventListener("click", reset);
$("#cancel-reset").addEventListener("click", () => {
  pendingConfig = null;
  $("#confirm-dialog").close();
});
$("#confirm-dialog").addEventListener("cancel", () => {
  pendingConfig = null;
});
document.querySelectorAll("[data-level]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.level !== config.level)
      requestReset({ level: button.dataset.level });
  }),
);
document.querySelectorAll("[data-color]").forEach((button) =>
  button.addEventListener("click", () => {
    if (Number(button.dataset.color) !== config.humanColor)
      requestReset({ humanColor: Number(button.dataset.color) });
  }),
);
$("#numbers").addEventListener("change", (event) => {
  preferences.numbers = event.target.checked;
  save();
  draw();
});
$("#sound").addEventListener("click", () => {
  preferences.sound = !preferences.sound;
  if (preferences.sound) audio.stone();
  save();
  updateUI();
});
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "z" &&
    !$("#confirm-dialog").open
  ) {
    event.preventDefault();
    undo();
  }
});

document.addEventListener(
  "pointerdown",
  () => {
    audio.unlock();
  },
  { passive: true },
);
document.addEventListener(
  "keydown",
  () => {
    audio.unlock();
  },
  { passive: true },
);
function updateMusicUI() {
  $("#music-mode").value = preferences.music;
  $("#music-volume").value = String(preferences.volume);
  $("#volume-label").textContent = `${preferences.volume}%`;
  $("#music-status").textContent =
    preferences.music === "off"
      ? "本地合成 · 离线可听"
      : audio.running
        ? preferences.music === "piano"
          ? "轻柔钢琴 · 正在播放"
          : "慢爵士 · 正在播放"
        : "轻点页面，即可继续播放";
}
$("#music-mode").addEventListener("change", (event) => {
  preferences.music = event.target.value;
  audio.setMusic(preferences.music);
  save();
  updateMusicUI();
});
$("#music-volume").addEventListener("input", (event) => {
  preferences.volume = Number(event.target.value);
  audio.setVolume(preferences.volume / 100);
  save();
  updateMusicUI();
});
audio.onStateChange = updateMusicUI;
window.addEventListener("pagehide", () => {
  save();
  cancelAI();
  audio.dispose();
});
loadSaved();
audio.setVolume(preferences.volume / 100);
audio.setMusic(preferences.music);
updateMusicUI();
updateUI();
new ResizeObserver(resize).observe(canvas);
if (storageAvailable)
  $("#save-status").textContent = game.moves.length
    ? "已恢复上次棋局 · 自动保存在本机"
    : "对局自动保存在本机";
startAI();
