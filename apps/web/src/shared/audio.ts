/**
 * Procedural audio for Beetle's web client.
 *
 * Everything is synthesised at runtime with the Web Audio API: oscillators,
 * noise buffers generated on start, biquad filters and a convolution reverb
 * fed by a generated impulse response. No audio files, no network.
 *
 * - Silent by default. Nothing is created until `start()` is called from a
 *   user gesture (click / keydown), and nothing is audible until
 *   `setEnabled(true)`. While disabled the AudioContext is suspended so the
 *   graph costs nothing.
 * - Two ambient beds ("serene", "volcanic") crossfade via `setTheme`.
 * - One-shot events (`onEvent`) are scheduled on the AudioContext clock.
 * - CPU stays low: a few dozen long-lived nodes, sparse short-lived nodes for
 *   one-shots and ambient details, and a 150 ms look-ahead scheduler. There is
 *   no per-frame work and no per-frame allocation.
 *
 * Usage (HUD):
 *   const audio = createAudio();
 *   soundToggle.addEventListener('click', () => {
 *     void audio.start();              // gesture: create / resume the context
 *     audio.setEnabled(!audio.enabled);
 *   });
 *   audio.setTheme('volcanic', 3);
 *   audio.onEvent('relic');
 */

export type AudioTheme = 'serene' | 'volcanic';

export type AudioEventName =
  | 'relic'
  | 'gate_unlock'
  | 'win'
  | 'commit'
  | 'fall'
  | 'respawn'
  | 'request_queued'
  | 'request_failed';

export interface BeetleAudio {
  /** Create or resume the AudioContext. Call from a click / keydown handler. */
  start(): Promise<void>;
  /** Tear the graph down and close the context. `start()` rebuilds it. */
  stop(): void;
  /** Mute / unmute. Default false (silent). */
  setEnabled(on: boolean): void;
  /** Crossfade ambient beds. `blendSeconds` defaults to 2.5. */
  setTheme(theme: AudioTheme, blendSeconds?: number): void;
  /** Play a one-shot game event. Ignored while disabled or not started. */
  onEvent(name: AudioEventName): void;
  /** Master volume 0..1. Default 0.6. */
  setMasterVolume(v: number): void;
  readonly enabled: boolean;
}

const DEFAULT_VOLUME = 0.6;
const DEFAULT_BLEND_SECONDS = 2.5;
const NOISE_SECONDS = 2;
const LOOP_XFADE_SAMPLES = 2048;
const TICK_MS = 150;
const LOOKAHEAD_SECONDS = 0.5;
const SILENT = 0.0001;

type AC = AudioContext;

interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  click: AudioBuffer;
}

interface SereneBed {
  out: GainNode;
  waterNext: number;
  birdNext: number;
}

interface VolcanicBed {
  out: GainNode;
  emberFilter: BiquadFilterNode;
  emberNext: number;
}

interface Graph {
  ctx: AC;
  master: GainNode;
  bedBus: GainNode;
  fxBus: GainNode;
  reverb: ConvolverNode;
  noise: NoiseBank;
  serene: SereneBed;
  volcanic: VolcanicBed;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crossfade the tail of a buffer into its head so looping is seamless (loopStart = xfade). */
function makeLoopSeamless(data: Float32Array, xfade: number): void {
  const len = data.length;
  if (len <= xfade * 2) return;
  for (let i = 0; i < xfade; i++) {
    const t = i / xfade;
    const tail = len - xfade + i;
    data[tail] = data[tail] * (1 - t) + data[i] * t;
  }
}

function makeNoiseBuffer(ctx: AC, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (kind === 'white') {
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's refined pink-noise filter.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // Leaky integrator for brown noise.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  }
  makeLoopSeamless(data, LOOP_XFADE_SAMPLES);
  return buffer;
}

/** A tiny decaying noise burst used for ember crackle / splash grit. */
function makeClickBuffer(ctx: AC): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.03);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const tau = ctx.sampleRate * 0.004;
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / tau);
  }
  return buffer;
}

/** Stereo exponentially-decaying noise with progressive high-frequency damping. */
function makeImpulseResponse(ctx: AC, seconds: number, decayPower: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const w = Math.random() * 2 - 1;
      // One-pole low-pass whose cutoff falls as the tail decays.
      lp += (w - lp) * (0.55 - 0.45 * t);
      data[i] = lp * Math.pow(1 - t, decayPower);
    }
  }
  return buffer;
}

function startLoop(ctx: AC, buffer: AudioBuffer, offset = 0): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = LOOP_XFADE_SAMPLES / ctx.sampleRate;
  src.loopEnd = buffer.duration;
  src.start(0, offset);
  return src;
}

function lfo(ctx: AC, hz: number, depth: number, target: AudioParam, type: OscillatorType = 'sine'): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = hz;
  const amount = ctx.createGain();
  amount.gain.value = depth;
  osc.connect(amount);
  amount.connect(target);
  osc.start();
}

function anchor(param: AudioParam, now: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
}

interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** Optional glide target reached at `t + glideSeconds`. */
  glideTo?: number;
  glideSeconds?: number;
  detune?: number;
  attack?: number;
  hold?: number;
  release?: number;
  peak: number;
  reverb?: number;
}

interface NoiseOpts {
  buffer: AudioBuffer;
  filter?: BiquadFilterType;
  freq?: number;
  /** Optional filter sweep, reached at `t + sweepSeconds`. */
  sweepTo?: number;
  sweepSeconds?: number;
  q?: number;
  attack?: number;
  hold?: number;
  release?: number;
  peak: number;
  reverb?: number;
  pan?: number;
}

export function createAudio(): BeetleAudio {
  let graph: Graph | null = null;
  let enabled = false;
  let volume = DEFAULT_VOLUME;
  let theme: AudioTheme = 'serene';
  let blendEnd = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let starting: Promise<void> | null = null;

  // ---------------------------------------------------------------- helpers

  function envelope(
    gain: AudioParam,
    t: number,
    attack: number,
    hold: number,
    release: number,
    peak: number,
  ): number {
    gain.setValueAtTime(SILENT, t);
    gain.linearRampToValueAtTime(peak, t + attack);
    gain.setValueAtTime(peak, t + attack + hold);
    gain.exponentialRampToValueAtTime(SILENT, t + attack + hold + release);
    return t + attack + hold + release;
  }

  function sendToReverb(g: Graph, from: AudioNode, amount: number): void {
    if (amount <= 0) return;
    const send = g.ctx.createGain();
    send.gain.value = amount;
    from.connect(send);
    send.connect(g.reverb);
  }

  function tone(g: Graph, out: AudioNode, t: number, o: ToneOpts): void {
    const { ctx } = g;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(o.glideTo, t + (o.glideSeconds ?? 0.2));
    }
    if (o.detune) osc.detune.value = o.detune;
    const amp = ctx.createGain();
    const end = envelope(amp.gain, t, o.attack ?? 0.005, o.hold ?? 0, o.release ?? 0.3, o.peak);
    osc.connect(amp);
    amp.connect(out);
    sendToReverb(g, amp, o.reverb ?? 0);
    osc.start(t);
    osc.stop(end + 0.05);
  }

  function noiseBurst(g: Graph, out: AudioNode, t: number, o: NoiseOpts): void {
    const { ctx } = g;
    const src = ctx.createBufferSource();
    src.buffer = o.buffer;
    src.loop = true;
    src.loopStart = LOOP_XFADE_SAMPLES / ctx.sampleRate;
    src.loopEnd = o.buffer.duration;
    let head: AudioNode = src;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter;
      f.frequency.setValueAtTime(o.freq ?? 1000, t);
      if (o.sweepTo !== undefined) {
        f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + (o.sweepSeconds ?? 0.3));
      }
      f.Q.value = o.q ?? 0.8;
      head.connect(f);
      head = f;
    }
    const amp = ctx.createGain();
    const end = envelope(amp.gain, t, o.attack ?? 0.005, o.hold ?? 0, o.release ?? 0.3, o.peak);
    head.connect(amp);
    let tail: AudioNode = amp;
    if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      amp.connect(p);
      tail = p;
    }
    tail.connect(out);
    sendToReverb(g, tail, o.reverb ?? 0);
    src.start(t, rand(0, NOISE_SECONDS - 0.5));
    src.stop(end + 0.05);
  }

  function emberClick(g: Graph, t: number, level: number, out: AudioNode = g.volcanic.emberFilter): void {
    const { ctx } = g;
    const src = ctx.createBufferSource();
    src.buffer = g.noise.click;
    src.playbackRate.value = rand(0.5, 1.8);
    const amp = ctx.createGain();
    amp.gain.value = level;
    src.connect(amp);
    amp.connect(out);
    src.start(t);
    src.stop(t + 0.06);
  }

  // ------------------------------------------------------------------- beds

  function buildSerene(g: Graph): SereneBed {
    const { ctx } = g;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.bedBus);
    sendToReverb(g, out, 0.1);

    // Wind: pink noise through a slowly wandering low-pass, with slow gusts.
    const wind = startLoop(ctx, g.noise.pink);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.32;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(out);
    lfo(ctx, 0.06, 230, windFilter.frequency);
    lfo(ctx, 0.013, 0.1, windGain.gain);

    return { out, waterNext: 0, birdNext: 0 };
  }

  function buildVolcanic(g: Graph): VolcanicBed {
    const { ctx } = g;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.bedBus);
    sendToReverb(g, out, 0.06);

    // Rumble: sub oscillator with slow drift + brown noise through a low-pass.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 42;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    sub.connect(subGain);
    subGain.connect(out);
    sub.start();
    lfo(ctx, 0.05, 2.5, sub.frequency);

    const brown = startLoop(ctx, g.noise.brown);
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 140;
    rumbleFilter.Q.value = 0.9;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.55;
    brown.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(out);
    lfo(ctx, 0.09, 55, rumbleFilter.frequency);
    lfo(ctx, 0.021, 0.14, rumbleGain.gain);

    // Embers: sparse clicks through a shared band-pass.
    const emberFilter = ctx.createBiquadFilter();
    emberFilter.type = 'bandpass';
    emberFilter.frequency.value = 2900;
    emberFilter.Q.value = 1.4;
    const emberGain = ctx.createGain();
    emberGain.gain.value = 0.22;
    emberFilter.connect(emberGain);
    emberGain.connect(out);

    // Heat hiss: faint high-passed white noise with a slow shimmer.
    const hiss = startLoop(ctx, g.noise.white, 0.7);
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 5200;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.028;
    hiss.connect(hissFilter);
    hissFilter.connect(hissGain);
    hissGain.connect(out);
    lfo(ctx, 0.15, 0.01, hissGain.gain);

    return { out, emberFilter, emberNext: 0 };
  }

  function waterLap(g: Graph, t: number): void {
    noiseBurst(g, g.serene.out, t, {
      buffer: g.noise.white,
      filter: 'bandpass',
      freq: rand(480, 1200),
      q: 0.7,
      attack: rand(0.25, 0.6),
      hold: rand(0.05, 0.2),
      release: rand(0.6, 1.4),
      peak: rand(0.08, 0.16),
      pan: rand(-0.6, 0.6),
      reverb: 0.15,
    });
  }

  function birdPhrase(g: Graph, t: number): void {
    const { ctx } = g;
    const voice = ctx.createGain();
    voice.gain.value = rand(0.035, 0.07);
    let tail: AudioNode = voice;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = rand(-0.8, 0.8);
      voice.connect(p);
      tail = p;
    }
    tail.connect(g.serene.out);
    sendToReverb(g, tail, 0.5);

    const count = 2 + Math.floor(Math.random() * 3);
    const base = rand(2300, 3600);
    let at = t;
    for (let i = 0; i < count; i++) {
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      const f0 = base * rand(0.92, 1.08);
      const dur = rand(0.05, 0.12);
      carrier.frequency.setValueAtTime(f0, at);
      carrier.frequency.exponentialRampToValueAtTime(f0 * rand(0.8, 1.45), at + dur);
      // FM trill.
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = rand(28, 70);
      const modDepth = ctx.createGain();
      modDepth.gain.value = rand(120, 420);
      mod.connect(modDepth);
      modDepth.connect(carrier.frequency);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, at, 0.012, dur * 0.4, dur * 0.8, 1);
      carrier.connect(amp);
      amp.connect(voice);
      carrier.start(at);
      mod.start(at);
      carrier.stop(end + 0.02);
      mod.stop(end + 0.02);
      at = end + rand(0.04, 0.16);
    }
  }

  function bedActive(name: AudioTheme, now: number): boolean {
    return theme === name || now < blendEnd;
  }

  function tick(): void {
    const g = graph;
    if (!g || g.ctx.state !== 'running') return;
    const now = g.ctx.currentTime;
    const horizon = now + LOOKAHEAD_SECONDS;
    const s = g.serene;
    const v = g.volcanic;

    if (bedActive('serene', now)) {
      if (s.waterNext < now) s.waterNext = now + rand(0.1, 0.8);
      while (s.waterNext < horizon) {
        waterLap(g, s.waterNext);
        s.waterNext += rand(1.4, 4.2);
      }
      if (s.birdNext < now) s.birdNext = now + rand(1.5, 6);
      while (s.birdNext < horizon) {
        birdPhrase(g, s.birdNext);
        s.birdNext += rand(6, 18);
      }
    } else {
      s.waterNext = Math.max(s.waterNext, horizon);
      s.birdNext = Math.max(s.birdNext, horizon);
    }

    if (bedActive('volcanic', now)) {
      if (v.emberNext < now) v.emberNext = now + rand(0.05, 0.4);
      while (v.emberNext < horizon) {
        emberClick(g, v.emberNext, rand(0.25, 1));
        const r = Math.random();
        v.emberNext += 0.06 + r * r * 1.3;
      }
    } else {
      v.emberNext = Math.max(v.emberNext, horizon);
    }
  }

  // ----------------------------------------------------------------- events

  function playRelic(g: Graph, t: number): void {
    const bell = (freq: number, at: number, amp: number): void => {
      tone(g, g.fxBus, at, { freq, attack: 0.003, release: 0.75, peak: 0.26 * amp, reverb: 0.45 });
      tone(g, g.fxBus, at, { freq: freq * 2, attack: 0.002, release: 0.2, peak: 0.05 * amp, reverb: 0.3 });
    };
    bell(1318.51, t, 1); // E6
    bell(1975.53, t + 0.1, 0.75); // B6, a fifth above
  }

  function playGateUnlock(g: Graph, t: number): void {
    const notes = [293.66, 369.99, 440]; // D4 F#4 A4
    notes.forEach((freq, i) => {
      const at = t + i * 0.13;
      tone(g, g.fxBus, at, { type: 'triangle', freq, attack: 0.03, hold: 0.45, release: 0.9, peak: 0.15, reverb: 0.85 });
    });
    tone(g, g.fxBus, t + 0.26, { freq: 880, attack: 0.06, hold: 0.4, release: 1.1, peak: 0.05, reverb: 0.9 });
  }

  function playWin(g: Graph, t: number): void {
    const { ctx } = g;
    const brass = ctx.createBiquadFilter();
    brass.type = 'lowpass';
    brass.frequency.value = 1700;
    brass.Q.value = 0.8;
    brass.connect(g.fxBus);
    const notes = [392, 523.25, 659.25, 783.99]; // G4 C5 E5 G5
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1;
      const at = t + i * 0.14;
      tone(g, brass, at, {
        type: 'sawtooth',
        freq,
        attack: 0.015,
        hold: last ? 0.45 : 0.07,
        release: last ? 0.7 : 0.12,
        peak: 0.11,
        reverb: 0.35,
      });
      tone(g, g.fxBus, at, {
        freq: freq / 2,
        attack: 0.02,
        hold: last ? 0.45 : 0.07,
        release: last ? 0.7 : 0.12,
        peak: 0.06,
      });
    });
  }

  function playCommit(g: Graph, t: number): void {
    noiseBurst(g, g.fxBus, t, {
      buffer: g.noise.white,
      filter: 'bandpass',
      freq: 260,
      sweepTo: 2400,
      sweepSeconds: 0.28,
      q: 1.1,
      attack: 0.09,
      hold: 0.08,
      release: 0.32,
      peak: 0.22,
      reverb: 0.2,
    });
    tone(g, g.fxBus, t + 0.11, { freq: 96, glideTo: 42, glideSeconds: 0.18, attack: 0.004, release: 0.3, peak: 0.45 });
  }

  function playFall(g: Graph, t: number): void {
    tone(g, g.fxBus, t, { type: 'triangle', freq: 820, glideTo: 140, glideSeconds: 0.55, attack: 0.02, hold: 0.1, release: 0.45, peak: 0.13 });
    const impact = t + 0.52;
    if (theme === 'serene') {
      noiseBurst(g, g.fxBus, impact, {
        buffer: g.noise.white,
        filter: 'bandpass',
        freq: 900,
        q: 0.6,
        attack: 0.012,
        hold: 0.05,
        release: 0.6,
        peak: 0.32,
        reverb: 0.35,
      });
      tone(g, g.fxBus, impact, { freq: 190, glideTo: 70, glideSeconds: 0.12, attack: 0.004, release: 0.18, peak: 0.2 });
    } else {
      noiseBurst(g, g.fxBus, impact, {
        buffer: g.noise.white,
        filter: 'highpass',
        freq: 2600,
        q: 0.7,
        attack: 0.015,
        hold: 0.25,
        release: 0.65,
        peak: 0.2,
        reverb: 0.15,
      });
      tone(g, g.fxBus, impact, { freq: 110, glideTo: 50, glideSeconds: 0.14, attack: 0.004, release: 0.22, peak: 0.22 });
      for (let i = 0; i < 5; i++) emberClick(g, impact + rand(0.02, 0.45), rand(0.4, 1), g.volcanic.emberFilter);
    }
  }

  function playRespawn(g: Graph, t: number): void {
    const voices: Array<[number, number]> = [
      [880, 6],
      [880, -6],
      [1318.51, 3],
      [1760, -4],
    ];
    for (const [freq, detune] of voices) {
      tone(g, g.fxBus, t, { freq, detune, attack: 0.5, hold: 0.3, release: 1.1, peak: 0.06, reverb: 0.7 });
    }
  }

  function playRequestQueued(g: Graph, t: number): void {
    tone(g, g.fxBus, t, { freq: 1900, attack: 0.001, hold: 0.006, release: 0.03, peak: 0.11 });
    noiseBurst(g, g.fxBus, t, { buffer: g.noise.white, filter: 'highpass', freq: 4000, attack: 0.001, hold: 0.004, release: 0.012, peak: 0.035 });
  }

  function playRequestFailed(g: Graph, t: number): void {
    const { ctx } = g;
    const mute = ctx.createBiquadFilter();
    mute.type = 'lowpass';
    mute.frequency.value = 650;
    mute.connect(g.fxBus);
    tone(g, mute, t, { type: 'triangle', freq: 196, attack: 0.01, hold: 0.08, release: 0.14, peak: 0.22 });
    tone(g, mute, t + 0.19, { type: 'triangle', freq: 174.61, attack: 0.01, hold: 0.1, release: 0.18, peak: 0.22 });
  }

  // ------------------------------------------------------------------ graph

  function applyMaster(rampSeconds = 0.15): void {
    const g = graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const target = enabled ? volume : 0;
    anchor(g.master.gain, now);
    g.master.gain.setTargetAtTime(target, now, Math.max(0.005, rampSeconds / 3));
  }

  function applyTheme(blendSeconds: number): void {
    const g = graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const dur = Math.max(0.02, blendSeconds);
    const sereneTarget = theme === 'serene' ? 1 : 0;
    anchor(g.serene.out.gain, now);
    g.serene.out.gain.linearRampToValueAtTime(sereneTarget, now + dur);
    anchor(g.volcanic.out.gain, now);
    g.volcanic.out.gain.linearRampToValueAtTime(1 - sereneTarget, now + dur);
    blendEnd = now + dur;
  }

  function build(ctx: AC): Graph {
    const master = ctx.createGain();
    master.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 18;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulseResponse(ctx, 1.7, 3);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.35;
    reverb.connect(reverbReturn);
    reverbReturn.connect(master);

    const bedBus = ctx.createGain();
    bedBus.gain.value = 0.7;
    bedBus.connect(master);
    const fxBus = ctx.createGain();
    fxBus.gain.value = 1;
    fxBus.connect(master);

    const noise: NoiseBank = {
      white: makeNoiseBuffer(ctx, 'white'),
      pink: makeNoiseBuffer(ctx, 'pink'),
      brown: makeNoiseBuffer(ctx, 'brown'),
      click: makeClickBuffer(ctx),
    };

    const partial = { ctx, master, bedBus, fxBus, reverb, noise } as Graph;
    partial.serene = buildSerene(partial);
    partial.volcanic = buildVolcanic(partial);
    return partial;
  }

  function resumeSoon(ctx: AC): Promise<void> {
    // resume() may stay pending forever without a gesture; never hang start().
    return Promise.race([ctx.resume().catch(() => undefined), delay(600)]);
  }

  function clearSuspendTimer(): void {
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
  }

  async function start(): Promise<void> {
    if (starting) return starting;
    starting = (async () => {
      clearSuspendTimer();
      if (graph) {
        if (graph.ctx.state === 'suspended') await resumeSoon(graph.ctx);
        applyMaster();
        return;
      }
      if (typeof window === 'undefined') return;
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      let ctx: AC;
      try {
        ctx = new Ctor();
      } catch {
        return;
      }
      graph = build(ctx);
      applyTheme(0.02);
      if (ctx.state === 'suspended') await resumeSoon(ctx);
      applyMaster();
      if (timer === null) timer = setInterval(tick, TICK_MS);
      if (!enabled) scheduleSuspend();
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  function scheduleSuspend(): void {
    clearSuspendTimer();
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      const g = graph;
      if (g && !enabled && g.ctx.state === 'running') void g.ctx.suspend().catch(() => undefined);
    }, 400);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    clearSuspendTimer();
    const g = graph;
    graph = null;
    blendEnd = 0;
    if (g) {
      try {
        g.master.disconnect();
      } catch {
        /* already gone */
      }
      void g.ctx.close().catch(() => undefined);
    }
  }

  function setEnabled(on: boolean): void {
    enabled = !!on;
    const g = graph;
    if (!g) return;
    if (enabled) {
      clearSuspendTimer();
      if (g.ctx.state === 'suspended') {
        void resumeSoon(g.ctx).then(() => applyMaster());
      } else {
        applyMaster();
      }
    } else {
      applyMaster(0.12);
      scheduleSuspend();
    }
  }

  function setTheme(next: AudioTheme, blendSeconds: number = DEFAULT_BLEND_SECONDS): void {
    if (next !== 'serene' && next !== 'volcanic') return;
    theme = next;
    applyTheme(Number.isFinite(blendSeconds) ? blendSeconds : DEFAULT_BLEND_SECONDS);
  }

  function setMasterVolume(v: number): void {
    volume = clamp01(v);
    applyMaster();
  }

  function onEvent(name: AudioEventName): void {
    const g = graph;
    if (!g || !enabled || g.ctx.state !== 'running') return;
    const t = g.ctx.currentTime + 0.02;
    switch (name) {
      case 'relic':
        playRelic(g, t);
        break;
      case 'gate_unlock':
        playGateUnlock(g, t);
        break;
      case 'win':
        playWin(g, t);
        break;
      case 'commit':
        playCommit(g, t);
        break;
      case 'fall':
        playFall(g, t);
        break;
      case 'respawn':
        playRespawn(g, t);
        break;
      case 'request_queued':
        playRequestQueued(g, t);
        break;
      case 'request_failed':
        playRequestFailed(g, t);
        break;
      default:
        break;
    }
  }

  return {
    start,
    stop,
    setEnabled,
    setTheme,
    onEvent,
    setMasterVolume,
    get enabled(): boolean {
      return enabled;
    },
  };
}
