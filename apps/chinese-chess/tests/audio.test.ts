import { describe, expect, mock, test } from 'bun:test';
import { Ambience, type MusicState } from '../src/renderer/audio';
class FakeMedia extends EventTarget {
  loop = false; preload = ''; volume = 1; src = ''; paused = true; failPlay = false;
  playCalls = 0; loadCalls = 0; currentTime = 10;
  async play() { this.playCalls++; if (this.failPlay) throw new Error('decoder failed'); this.paused = false; }
  pause() { this.paused = true; }
  load() { this.loadCalls++; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
function fixture() {
  const media = new FakeMedia(), audio = new Ambience(media as unknown as HTMLAudioElement);
  let state: MusicState;
  audio.subscribe(value => { state = value; });
  return { audio, media, state: () => state! };
}
describe('round result sound effects', () => {
  test('plays a short offline arpeggio without starting music, disconnects nodes and closes on dispose', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    const oscillators: any[] = [], gains: any[] = [];
    class FakeContext {
      currentTime = 10; destination = {}; resume = mock(async () => {}); close = mock(async () => {});
      createOscillator() {
        const osc = { type: '', frequency: { setValueAtTime: mock() }, connect: mock(), disconnect: mock(), start: mock(), stop: mock(), onended: () => {} };
        oscillators.push(osc); return osc;
      }
      createGain() {
        const gain = { gain: { setValueAtTime: mock(), linearRampToValueAtTime: mock(), exponentialRampToValueAtTime: mock() }, connect: mock(), disconnect: mock() };
        gains.push(gain); return gain;
      }
    }
    const context = new FakeContext();
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: function () { return context; } });
    const f = fixture();
    try {
      await f.audio.victory();
      expect(context.resume).toHaveBeenCalledTimes(1);
      expect(oscillators).toHaveLength(6); expect(f.media.playCalls).toBe(0);
      expect(oscillators.map(o => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([523.25, 659.25, 783.99, 1046.5, 659.25, 783.99]);
      for (const [i, osc] of oscillators.entries()) {
        expect(osc.stop.mock.calls[0][0] - osc.start.mock.calls[0][0]).toBeCloseTo(.7);
        osc.onended(); expect(osc.disconnect).toHaveBeenCalledTimes(1); expect(gains[i].disconnect).toHaveBeenCalledTimes(1);
      }
      // A machine win plays a quieter four-note descending phrase instead.
      await f.audio.victory('machine');
      const machine = oscillators.slice(6);
      expect(machine.map(o => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([659.25, 587.33, 523.25, 392]);
      expect(machine.every(o => o.type === 'sine')).toBe(true);
      expect(gains.slice(6).every(g => g.gain.linearRampToValueAtTime.mock.calls[0][0] < .035)).toBe(true);
      f.audio.dispose(); expect(context.close).toHaveBeenCalledTimes(1);
      await f.audio.victory(); expect(oscillators).toHaveLength(10);
    } finally {
      f.audio.dispose();
      if (original) Object.defineProperty(globalThis, 'AudioContext', original);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  });
});
