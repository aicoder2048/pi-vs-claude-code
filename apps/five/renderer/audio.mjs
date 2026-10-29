// Original generative arrangements: no recordings, network, or third-party music assets.
const midi = (note) => 440 * 2 ** ((note - 69) / 12);
const HARMONY = [
  { bass: 36, chord: [48, 55, 59, 64], melody: [76, 74, 71, 67] }, // Cmaj7
  { bass: 33, chord: [48, 55, 60, 64], melody: [72, 71, 69, 64] }, // Am7
  { bass: 29, chord: [48, 53, 57, 64], melody: [69, 67, 65, 64] }, // Fmaj7
  { bass: 31, chord: [50, 55, 57, 62], melody: [67, 69, 74, 71] }, // Gadd9
  { bass: 38, chord: [50, 57, 60, 65], melody: [77, 76, 72, 69] }, // Dm7
  { bass: 31, chord: [47, 53, 57, 62], melody: [74, 72, 69, 67] }, // G9
  { bass: 36, chord: [48, 55, 59, 64], melody: [71, 72, 76, 74] }, // Cmaj7
  { bass: 33, chord: [48, 52, 55, 59], melody: [72, 71, 67, 64] }, // Am9
];

export class AudioEngine {
  constructor() {
    this.context = null;
    this.mode = "off";
    this.volume = 0.3;
    this.session = null;
    this.interval = null;
    this.onStateChange = null;
  }

  get running() {
    return (
      this.context?.state === "running" &&
      this.mode !== "off" &&
      Boolean(this.session)
    );
  }

  unlock() {
    try {
      if (!this.context) this.createContext();
      if (this.context.state === "suspended")
        this.context
          .resume()
          .then(() => {
            this.ensureMusic();
            this.onStateChange?.();
          })
          .catch(() => {});
      this.ensureMusic();
    } catch {
      /* Audio may be unavailable; the game remains fully playable. */
    }
  }

  createContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = (this.context = new AudioContext());
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 20;
    compressor.ratio.value = 3;
    compressor.connect(context.destination);
    this.output = compressor;
    this.musicGain = context.createGain();
    this.musicGain.gain.value = this.volume * 0.65;
    this.musicGain.connect(compressor);
    this.reverb = context.createConvolver();
    const impulse = context.createBuffer(
      2,
      context.sampleRate * 2.8,
      context.sampleRate,
    );
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < data.length; i++)
        data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3 * 0.45;
    }
    this.reverb.buffer = impulse;
    const wet = context.createGain();
    wet.gain.value = 0.2;
    this.reverb.connect(wet).connect(this.musicGain);
    context.onstatechange = () => {
      this.ensureMusic();
      this.onStateChange?.();
    };
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.context)
      this.musicGain.gain.setTargetAtTime(
        this.volume * 0.65,
        this.context.currentTime,
        0.08,
      );
  }

  setMusic(mode) {
    if (!["off", "piano", "jazz"].includes(mode)) mode = "off";
    if (this.mode !== mode) {
      this.stopMusic();
      this.mode = mode;
    }
    this.ensureMusic();
    this.onStateChange?.();
  }

  ensureMusic() {
    if (
      !this.context ||
      this.context.state !== "running" ||
      this.mode === "off" ||
      this.session
    )
      return;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, this.context.currentTime);
    gain.gain.linearRampToValueAtTime(1, this.context.currentTime + 1.2);
    gain.connect(this.musicGain);
    gain.connect(this.reverb);
    this.session = {
      gain,
      sources: new Set(),
      beat: 0,
      nextTime: this.context.currentTime + 0.12,
      mode: this.mode,
    };
    this.schedule();
    this.interval = setInterval(() => this.schedule(), 100);
    this.onStateChange?.();
  }

  stopMusic() {
    clearInterval(this.interval);
    this.interval = null;
    const session = this.session;
    this.session = null;
    if (!session || !this.context) return;
    const time = this.context.currentTime;
    session.gain.gain.cancelScheduledValues(time);
    session.gain.gain.setTargetAtTime(0, time, 0.05);
    for (const source of session.sources) {
      try {
        source.stop(time + 0.2);
      } catch {
        /* already ended */
      }
    }
    setTimeout(() => session.gain.disconnect(), 350);
  }

  track(source, session) {
    session.sources.add(source);
    source.onended = () => {
      session.sources.delete(source);
      source.disconnect();
    };
  }

  note(note, time, duration, velocity, timbre = "piano") {
    const session = this.session;
    if (!session) return;
    const context = this.context;
    const envelope = context.createGain();
    const peak = velocity * 0.28;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(peak, time + 0.016);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * 0.22),
      time + duration * 0.35,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    envelope.connect(session.gain);
    const partials =
      timbre === "bass"
        ? [1, 0.22]
        : timbre === "jazz"
          ? [1, 0.2, 0.08, 0.025]
          : [1, 0.32, 0.13, 0.045, 0.018];
    partials.forEach((amplitude, harmonic) => {
      const osc = context.createOscillator();
      const partial = context.createGain();
      osc.type = "sine";
      osc.frequency.value =
        midi(note) * (harmonic + 1) * (1 + harmonic * harmonic * 0.00015);
      partial.gain.value = amplitude;
      osc.connect(partial).connect(envelope);
      this.track(osc, session);
      osc.start(time);
      osc.stop(time + duration + 0.05);
    });
  }

  brush(time) {
    const session = this.session;
    if (!session) return;
    const context = this.context;
    const noise = context.createBufferSource();
    const buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * 0.12),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++)
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    noise.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 4200;
    filter.Q.value = 0.7;
    const gain = context.createGain();
    gain.gain.value = 0.023;
    noise.connect(filter).connect(gain).connect(session.gain);
    this.track(noise, session);
    noise.start(time);
  }

  schedule() {
    const session = this.session;
    if (!session || this.context.state !== "running") return;
    const beatLength = 60 / (session.mode === "jazz" ? 62 : 66);
    // Timers may be throttled while minimized. Skip gaps instead of stacking old notes.
    if (session.nextTime < this.context.currentTime - 0.1)
      session.nextTime = this.context.currentTime + 0.05;
    while (session.nextTime < this.context.currentTime + 0.45) {
      const beat = session.beat % 4;
      const bar = Math.floor(session.beat / 4) % HARMONY.length;
      const { bass, chord, melody } = HARMONY[bar];
      const time = session.nextTime;
      if (session.mode === "piano") {
        if (beat === 0) this.note(bass + 12, time, 3.4, 0.55);
        this.note(chord[beat] + 12, time + 0.025, 2.7, 0.37);
        if (beat !== 3 || bar % 2 === 0)
          this.note(
            melody[beat],
            time + beatLength * 0.5,
            2.5,
            beat === 0 ? 0.48 : 0.34,
          );
      } else {
        if (beat === 0 || beat === 2) {
          this.note(bass + (beat === 2 ? 7 : 0), time, 1.5, 0.65, "bass");
          for (const [i, note] of chord.entries())
            this.note(
              note + 12,
              time + i * 0.018 + (beat === 2 ? 0.1 : 0),
              3.0,
              0.22,
              "jazz",
            );
        }
        if (beat !== 1)
          this.note(
            melody[beat],
            time + beatLength * (beat % 2 ? 0.66 : 0.08),
            1.8,
            0.3,
            "jazz",
          );
        if (beat === 1 || beat === 3) this.brush(time + 0.02);
      }
      session.beat++;
      session.nextTime += beatLength;
    }
  }

  stone() {
    this.unlock();
    if (!this.context) return;
    const context = this.context;
    const time = context.currentTime + 0.01;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(760, time);
    osc.frequency.exponentialRampToValueAtTime(260, time + 0.05);
    gain.gain.setValueAtTime(0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
    osc.connect(gain).connect(this.output);
    osc.start(time);
    osc.stop(time + 0.12);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  dispose() {
    this.stopMusic();
    this.context?.close().catch(() => {});
  }
}
