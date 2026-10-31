import type { GameState } from '../shared/types';

export type RoundWinner = 'human' | 'machine';

// Only a newly settled, observed live round counts: no bootstrap/replay/heartbeat celebrations.
// A draw has no winner and is never celebrated.
export function newRoundWinner(previous: GameState | undefined, next: GameState): RoundWinner | null {
  if (!previous || previous.id !== next.id || previous.outcome || !next.outcome || next.outcome.winner === 'draw') return null;
  return next.outcome.winner === next.human ? 'human' : 'machine';
}

const MESSAGES: Record<RoundWinner, { round: string; match: string }> = {
  human: { round: '好棋，你赢了这一局！', match: '太棒了，赢下整场比赛！' },
  machine: { round: '这局大模型胜出，重整旗鼓再战！', match: '大模型赢下整场比赛，来日再战！' },
};
const CONFETTI = ['#d5a83e', '#e77865', '#68a995', '#73b9d0', '#ad8bc7', '#f5df9b'];
const INK = ['#5d6b78', '#7d8a94', '#98a3a8', '#4b5a66'];
const DURATION = 3400;

interface Particle { x: number; y: number; vx: number; vy: number; gravity: number; size: number; spin: number; color: string; delay: number }

// Human win: confetti bursts from both sides. Machine win: a sparse, slow ink rain
// from the top, deliberately quieter so a loss is acknowledged rather than cheered.
function particles(winner: RoundWinner, matchWon: boolean, width: number, height: number): Particle[] {
  if (winner === 'human') return Array.from({ length: matchWon ? 220 : 150 }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    return { x: side < 0 ? width * .12 : width * .88, y: height * .65, vx: -side * (90 + Math.random() * 340), vy: -350 - Math.random() * 420,
      gravity: 240, size: 5 + Math.random() * 6, spin: Math.random() * Math.PI * 2, color: CONFETTI[i % CONFETTI.length], delay: Math.random() * .22 };
  });
  return Array.from({ length: matchWon ? 110 : 70 }, (_, i) => ({
    x: Math.random() * width, y: -20 - Math.random() * height * .25, vx: (Math.random() - .5) * 30, vy: 120 + Math.random() * 110,
    gravity: 20, size: 3 + Math.random() * 4, spin: Math.random() * Math.PI * 2, color: INK[i % INK.length], delay: Math.random() * .9,
  }));
}

export class VictoryCelebration {
  private frame?: number;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private layer: HTMLElement, private canvas: HTMLCanvasElement, private message: HTMLElement) {}

  /** `motion` false keeps the static message but skips moving particles (reduced motion / animations off). */
  play(winner: RoundWinner, matchWon: boolean, motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches): void {
    this.stop();
    this.message.textContent = MESSAGES[winner][matchWon ? 'match' : 'round'];
    this.layer.classList.toggle('machine', winner === 'machine');
    this.layer.hidden = false;
    this.timer = setTimeout(() => this.stop(), DURATION);
    if (!motion) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const width = window.innerWidth, height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const list = particles(winner, matchWon, width, height);
    const began = performance.now();
    const draw = (now: number) => {
      const elapsed = now - began;
      if (elapsed >= DURATION) { this.stop(); return; }
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = Math.min(winner === 'human' ? 1 : .55, (DURATION - elapsed) / 650);
      for (const p of list) {
        const t = elapsed / 1000 - p.delay;
        if (t < 0) continue;
        ctx.save();
        ctx.fillStyle = p.color;
        if (winner === 'human') {
          ctx.translate(p.x + p.vx * t, p.y + p.vy * t + p.gravity * t * t);
          ctx.rotate(p.spin + t * 6);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * Math.cos(t * 9 + p.spin));
        } else {
          // Ink drops sway gently and stretch slightly as they fall.
          ctx.translate(p.x + p.vx * t + Math.sin(t * 2 + p.spin) * 12, p.y + p.vy * t + p.gravity * t * t);
          ctx.beginPath(); ctx.ellipse(0, 0, p.size / 2, p.size * .8, 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    clearTimeout(this.timer); this.frame = undefined; this.timer = undefined;
    this.layer.hidden = true;
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
