import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Ambience, MUSIC_TRACKS, type MusicState } from '../src/renderer/audio';
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
describe('victory sound effect', () => {
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
      f.audio.dispose(); expect(context.close).toHaveBeenCalledTimes(1);
      await f.audio.victory(); expect(oscillators).toHaveLength(6);
    } finally {
      f.audio.dispose();
      if (original) Object.defineProperty(globalThis, 'AudioContext', original);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  });
});

describe('local recorded background music', () => {
  test('bundled MP3s are original audio bytes with accompanying attribution', async () => {
    const hashes = ['8cba6bb3da51066ad39520ec218a327bb6222d8fb32bc52f28a1e90b67756f70', '732871fa31755c4a3ae260cccbdd4044b81ad49cabf8fbb1ee0f5927d36d7d79'];
    for (const [i, track] of Object.values(MUSIC_TRACKS).entries()) {
      const file = Bun.file(`src/renderer/${track.file}`), bytes = await file.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(1_000_000);
      expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).toBe(hashes[i]);
    }
    const credits = await Bun.file('src/renderer/assets/music/ATTRIBUTION.md').text();
    expect(credits).toContain('Kevin MacLeod'); expect(credits).toContain('https://creativecommons.org/licenses/by/4.0/');
  });
  test('starts paused, without an autoplay request or a synthesizer', () => {
    const f = fixture(); expect(f.media.playCalls).toBe(0); expect(f.media.loop).toBe(true);
    expect(f.media.src).toBe(MUSIC_TRACKS.piano.file); expect(f.state().playing).toBe(false); f.audio.dispose();
  });
  test('play fades to low volume; pause/resume preserves playback position', async () => {
    const f = fixture();
    expect(await f.audio.toggle()).toBe(true); expect(f.media.volume).toBeCloseTo(.12);
    f.audio.setVolume(.2); expect(f.media.volume).toBeCloseTo(.2);
    expect(await f.audio.toggle()).toBe(false); expect(f.media.paused).toBe(true); expect(f.media.currentTime).toBe(10);
    expect(await f.audio.toggle()).toBe(true); expect(f.media.currentTime).toBe(10); f.audio.dispose();
  });
  test('switching recordings while playing restarts playback and retains volume', async () => {
    const f = fixture(); f.audio.setVolume(.08); await f.audio.toggle(); await f.audio.setStyle('jazz');
    expect(f.media.src).toBe(MUSIC_TRACKS.jazz.file); expect(f.media.playCalls).toBe(2);
    expect(f.state()).toMatchObject({ style: 'jazz', playing: true, busy: false, error: null });
    expect(f.media.volume).toBeCloseTo(.08); f.audio.dispose();
  });
  test('decoder failure is surfaced and can be retried; later media errors clear playback', async () => {
    const f = fixture(); f.media.failPlay = true;
    await expect(f.audio.toggle()).rejects.toThrow(); expect(f.state().playing).toBe(false); expect(f.state().error).not.toBeNull();
    f.media.failPlay = false; await f.audio.toggle(); expect(f.state().error).toBeNull();
    f.media.dispatchEvent(new Event('error')); expect(f.state().playing).toBe(false); expect(f.media.paused).toBe(true); f.audio.dispose();
  });
  test('switching while paused never autoplays; dispose cancels an in-progress fade', async () => {
    const f = fixture(); await f.audio.setStyle('jazz'); expect(f.media.playCalls).toBe(0);
    const playing = f.audio.toggle(); await Bun.sleep(30); f.audio.dispose(); await playing;
    expect(f.media.paused).toBe(true); expect(f.media.src).toBe('');
  });
});
