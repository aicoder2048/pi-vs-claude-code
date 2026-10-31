import type { GameState } from '../shared/types';

// Only a newly settled, observed live round counts: no bootstrap/replay/heartbeat celebrations.
export function isNewHumanWin(previous: GameState | undefined, next: GameState): boolean {
  return !!previous && previous.id === next.id && !previous.outcome
    && !!next.outcome && next.outcome.winner === next.human;
}

const COLORS = ['#d5a83e', '#e77865', '#68a995', '#73b9d0', '#ad8bc7', '#f5df9b'];
const DURATION = 3400;

export class VictoryCelebration {
  private frame?: number;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private layer: HTMLElement, private canvas: HTMLCanvasElement, private message: HTMLElement) {}

  play(matchWon: boolean): void {
    this.stop();
    this.message.textContent = matchWon ? '太棒了，赢下整场比赛！' : '好棋，你赢了这一局！';
    this.layer.hidden = false;
    this.timer = setTimeout(() => this.stop(), DURATION);
    // Keep the congratulatory message, but skip moving particles for reduced-motion users.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const width = window.innerWidth, height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const particles = Array.from({ length: matchWon ? 220 : 150 }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      return {
        x: side < 0 ? width * .12 : width * .88, y: height * .65,
        vx: -side * (90 + Math.random() * 340), vy: -350 - Math.random() * 420,
        size: 5 + Math.random() * 6, spin: Math.random() * Math.PI * 2,
        color: COLORS[i % COLORS.length], delay: Math.random() * .22,
      };
    });
    const began = performance.now();
    const draw = (now: number) => {
      const elapsed = now - began;
      if (elapsed >= DURATION) { this.stop(); return; }
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = Math.min(1, (DURATION - elapsed) / 650);
      for (const p of particles) {
        const t = elapsed / 1000 - p.delay;
        if (t < 0) continue;
        ctx.save();
        ctx.translate(p.x + p.vx * t, p.y + p.vy * t + 240 * t * t);
        ctx.rotate(p.spin + t * 6);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * Math.cos(t * 9 + p.spin));
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
