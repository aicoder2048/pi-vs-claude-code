export const MUSIC_TRACKS = {
  piano: { title: 'Gymnopedie No. 1', file: 'assets/music/gymnopedie-no-1.mp3', artist: 'Kevin MacLeod' },
  jazz: { title: 'Night on the Docks - Sax', file: 'assets/music/night-on-the-docks-sax.mp3', artist: 'Kevin MacLeod' },
} as const;
export type MusicStyle = keyof typeof MUSIC_TRACKS;
export interface MusicState { style: MusicStyle; playing: boolean; busy: boolean; error: string | null }

// Background music is local, licensed full-length audio, not synthesized notes.
// Web Audio supplies only short stone-placement and round-result sound effects.
export class Ambience {
  private context?: AudioContext;
  private style: MusicStyle = 'piano';
  private volume = .12;
  private playing = false;
  private busy = false;
  private disposed = false;
  private error: string | null = null;
  private listeners = new Set<(state: MusicState) => void>();
  private ramp?: { timer: ReturnType<typeof setInterval>; resolve: () => void };
  private onError = () => {
    this.cancelRamp(); this.media.pause(); this.playing = false;
    this.error = '背景音乐无法播放，请检查本地音频文件或系统声音设备'; this.emit();
  };
  constructor(private media: HTMLAudioElement) {
    media.loop = true; media.preload = 'none'; media.volume = 0;
    media.src = MUSIC_TRACKS[this.style].file;
    media.addEventListener('error', this.onError);
  }
  subscribe(listener: (state: MusicState) => void): () => void {
    this.listeners.add(listener); listener(this.state()); return () => this.listeners.delete(listener);
  }
  private state(): MusicState { return { style: this.style, playing: this.playing, busy: this.busy, error: this.error }; }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(this.state()); }
  private cancelRamp(): void {
    if (this.ramp) { clearInterval(this.ramp.timer); this.ramp.resolve(); this.ramp = undefined; }
  }
  private fade(target: () => number, duration: number): Promise<void> {
    this.cancelRamp();
    const start = this.media.volume, began = performance.now();
    return new Promise(resolve => {
      const timer = setInterval(() => {
        const progress = Math.min(1, (performance.now() - began) / duration);
        // Smoothstep prevents an abrupt volume edge at either end.
        const amount = progress * progress * (3 - 2 * progress);
        this.media.volume = Math.max(0, Math.min(.5, start + (target() - start) * amount));
        if (progress >= 1) { clearInterval(timer); this.ramp = undefined; resolve(); }
      }, 16);
      this.ramp = { timer, resolve };
    });
  }
  private async play(): Promise<void> {
    this.media.volume = 0;
    if (this.media.error) this.media.load(); // retry a previous decoder/network failure
    await this.media.play();
    if (this.disposed || this.error) { this.media.pause(); return; }
    this.playing = true; this.emit();
    await this.fade(() => this.volume, 650);
  }
  async toggle(): Promise<boolean> {
    if (this.busy || this.disposed) return this.playing;
    this.busy = true; this.error = null; this.emit();
    try {
      if (this.playing) {
        await this.fade(() => 0, 180); this.media.pause(); this.playing = false;
      } else await this.play();
      return this.playing;
    } catch (error) {
      this.playing = false; this.media.pause();
      this.error = '背景音乐无法播放，请检查本地音频文件或系统声音设备'; throw error;
    } finally { this.busy = false; this.emit(); }
  }
  async setStyle(style: MusicStyle): Promise<void> {
    if (style === this.style || this.busy || this.disposed) return;
    this.busy = true; this.error = null; this.emit();
    const resume = this.playing;
    try {
      if (resume) await this.fade(() => 0, 180);
      if (this.disposed) return;
      this.media.pause(); this.playing = false; this.style = style;
      this.media.src = MUSIC_TRACKS[style].file; this.media.load();
      this.emit();
      if (resume) await this.play();
    } catch (error) {
      this.playing = false; this.media.pause();
      this.error = '背景音乐切换失败，请检查本地音频文件'; throw error;
    } finally { this.busy = false; this.emit(); }
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(.5, volume));
    if (!this.ramp && this.playing) this.media.volume = this.volume;
  }
  async stone(): Promise<void> {
    if (this.disposed) return;
    this.context ??= new AudioContext();
    const ctx = this.context; await ctx.resume();
    if (this.disposed) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(700, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(240, ctx.currentTime + .055);
    gain.gain.setValueAtTime(.025, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .1);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .12);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
  async victory(winner: 'human' | 'machine' = 'human'): Promise<void> {
    if (this.disposed) return;
    this.context ??= new AudioContext();
    const ctx = this.context; await ctx.resume();
    if (this.disposed) return;
    // Human: a soft ascending major arpeggio with a final chord. Machine: a quieter
    // descending phrase that acknowledges the result without cheering. Entirely offline.
    const human = winner === 'human';
    const notes = human ? [523.25, 659.25, 783.99, 1046.5, 659.25, 783.99] : [659.25, 587.33, 523.25, 392];
    const start = ctx.currentTime;
    for (const [i, frequency] of notes.entries()) {
      const at = start + (human ? (i < 4 ? i * .12 : .36) : i * .16);
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = human ? 'triangle' : 'sine'; osc.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(human ? .035 : .025, at + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, at + .65);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(at); osc.stop(at + .7);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
  }
  dispose(): void {
    this.disposed = true; this.cancelRamp(); this.media.pause();
    this.media.removeEventListener('error', this.onError);
    this.media.removeAttribute('src'); this.media.load();
    this.playing = false; this.listeners.clear();
    void this.context?.close().catch(() => {});
  }
}
