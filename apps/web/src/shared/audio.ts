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
 * - Five ambient beds ("serene", "volcanic", "frost", "desert", "night")
 *   crossfade via `setTheme`. Serene and volcanic are built with the graph;
 *   the other beds are built lazily the first time they are selected.
 * - One-shot events (`onEvent`) are scheduled on the AudioContext clock.
 * - CPU stays low: a few dozen long-lived nodes, sparse short-lived nodes for
 *   one-shots and ambient details, and a 150 ms look-ahead scheduler. There is
 *   no per-frame work and no per-frame allocation. Ambient details are only
 *   scheduled for beds that are audible (current theme or mid-crossfade).
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

export type AudioTheme = 'serene' | 'volcanic' | 'frost' | 'desert' | 'night';

export type AudioEventName =
  | 'relic'
  | 'gate_unlock'
  | 'win'
  | 'commit'
  | 'fall'
  | 'respawn'
  | 'request_queued'
  | 'request_failed'
  | 'checkpoint'
  | 'tick_warning'
  | 'hill_tick'
  | 'lost'
  | 'biome_change';

const THEMES: readonly AudioTheme[] = ['serene', 'volcanic', 'frost', 'desert', 'night'];

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

interface FrostBed {
  out: GainNode;
  /** Shared low-pass for ice crack clicks. */
  crackFilter: BiquadFilterNode;
  creakNext: number;
}

interface DesertBed {
  out: GainNode;
  cryNext: number;
}

interface NightBed {
  out: GainNode;
  cricketNext: number;
  hootNext: number;
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
  /** Lazily built beds (null until first selected). */
  frost: FrostBed | null;
  desert: DesertBed | null;
  night: NightBed | null;
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

/**
 * Advance a sparse-event scheduler. When `active`, fires `fire(at)` for every
 * due time before `horizon` and returns the next due time; when inactive,
 * pushes the next due time past the horizon so nothing fires.
 */
function scheduleSparse(
  next: number,
  active: boolean,
  now: number,
  horizon: number,
  first: readonly [number, number],
  gap: readonly [number, number],
  fire: (at: number) => void,
): number {
  if (!active) return Math.max(next, horizon);
  let at = next < now ? now + rand(first[0], first[1]) : next;
  while (at < horizon) {
    fire(at);
    at += rand(gap[0], gap[1]);
  }
  return at;
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

  function buildFrost(g: Graph): FrostBed {
    const { ctx } = g;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.bedBus);
    sendToReverb(g, out, 0.14);

    // Thin high wind: white noise through a wandering high-pass, slow gusts.
    const wind = startLoop(ctx, g.noise.white, 0.3);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'highpass';
    windFilter.frequency.value = 1500;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.045;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(out);
    lfo(ctx, 0.07, 500, windFilter.frequency);
    lfo(ctx, 0.037, 0.022, windGain.gain);

    // Whistling resonances: two narrow band-passes on the wind whose centre
    // frequencies sweep slowly and whose levels breathe in and out of phase.
    const whistle = (centre: number, sweepHz: number, sweepDepth: number, levelHz: number): void => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = centre;
      bp.Q.value = 16;
      const level = ctx.createGain();
      level.gain.value = 0.16;
      windFilter.connect(bp);
      bp.connect(level);
      level.connect(out);
      lfo(ctx, sweepHz, sweepDepth, bp.frequency);
      lfo(ctx, levelHz, 0.12, level.gain);
    };
    whistle(1900, 0.023, 650, 0.031);
    whistle(2750, 0.016, 900, 0.019);

    // Ice cracks: tight clicks through a shared low-pass.
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'lowpass';
    crackFilter.frequency.value = 1100;
    crackFilter.Q.value = 1.2;
    const crackGain = ctx.createGain();
    crackGain.gain.value = 0.3;
    crackFilter.connect(crackGain);
    crackGain.connect(out);

    return { out, crackFilter, creakNext: 0 };
  }

  function buildDesert(g: Graph): DesertBed {
    const { ctx } = g;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.bedBus);
    sendToReverb(g, out, 0.05);

    // Dry wind: pink noise through a high-pass that wanders, slow gusts.
    const wind = startLoop(ctx, g.noise.pink, 0.9);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'highpass';
    windFilter.frequency.value = 650;
    windFilter.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.15;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(out);
    lfo(ctx, 0.05, 280, windFilter.frequency);
    lfo(ctx, 0.029, 0.06, windGain.gain);

    // Sand hiss: high-passed white noise with a slow LFO so it drifts in waves.
    const sand = startLoop(ctx, g.noise.white, 1.2);
    const sandFilter = ctx.createBiquadFilter();
    sandFilter.type = 'highpass';
    sandFilter.frequency.value = 5600;
    const sandGain = ctx.createGain();
    sandGain.gain.value = 0.022;
    sand.connect(sandFilter);
    sandFilter.connect(sandGain);
    sandGain.connect(out);
    lfo(ctx, 0.11, 0.012, sandGain.gain);
    lfo(ctx, 0.017, 0.008, sandGain.gain);

    return { out, cryNext: 0 };
  }

  function buildNight(g: Graph): NightBed {
    const { ctx } = g;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.bedBus);
    sendToReverb(g, out, 0.12);

    // Deep quiet bed: brown noise through a very low low-pass, plus a faint
    // sub drone that drifts.
    const deep = startLoop(ctx, g.noise.brown, 0.4);
    const deepFilter = ctx.createBiquadFilter();
    deepFilter.type = 'lowpass';
    deepFilter.frequency.value = 120;
    deepFilter.Q.value = 0.7;
    const deepGain = ctx.createGain();
    deepGain.gain.value = 0.2;
    deep.connect(deepFilter);
    deepFilter.connect(deepGain);
    deepGain.connect(out);
    lfo(ctx, 0.031, 0.06, deepGain.gain);

    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 55;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.05;
    drone.connect(droneGain);
    droneGain.connect(out);
    drone.start();
    lfo(ctx, 0.07, 0.9, drone.frequency);

    // Soft breeze: pink noise through a low low-pass, barely moving.
    const breeze = startLoop(ctx, g.noise.pink, 1.4);
    const breezeFilter = ctx.createBiquadFilter();
    breezeFilter.type = 'lowpass';
    breezeFilter.frequency.value = 360;
    breezeFilter.Q.value = 0.6;
    const breezeGain = ctx.createGain();
    breezeGain.gain.value = 0.1;
    breeze.connect(breezeFilter);
    breezeFilter.connect(breezeGain);
    breezeGain.connect(out);
    lfo(ctx, 0.047, 130, breezeFilter.frequency);
    lfo(ctx, 0.019, 0.05, breezeGain.gain);

    return { out, cricketNext: 0, hootNext: 0 };
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

  /** Frost: a short low filtered noise groan with a few tight cracks in it. */
  function iceCreak(g: Graph, t: number): void {
    const f = g.frost;
    if (!f) return;
    const pan = rand(-0.7, 0.7);
    noiseBurst(g, f.out, t, {
      buffer: g.noise.brown,
      filter: 'bandpass',
      freq: rand(260, 520),
      sweepTo: rand(90, 170),
      sweepSeconds: rand(0.15, 0.3),
      q: 4,
      attack: 0.006,
      hold: rand(0.02, 0.06),
      release: rand(0.12, 0.32),
      peak: rand(0.14, 0.3),
      pan,
      reverb: 0.3,
    });
    const cracks = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < cracks; i++) emberClick(g, t + rand(0, 0.14), rand(0.2, 0.5), f.crackFilter);
  }

  /** Desert: a distant two-note descending cry with a raspy FM edge. */
  function hawkCry(g: Graph, t: number): void {
    const d = g.desert;
    if (!d) return;
    const { ctx } = g;
    const voice = ctx.createGain();
    voice.gain.value = rand(0.018, 0.034);
    let tail: AudioNode = voice;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = rand(-0.8, 0.8);
      voice.connect(p);
      tail = p;
    }
    tail.connect(d.out);
    sendToReverb(g, tail, 0.65);

    const f0 = rand(2100, 2700);
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    // Note 1: quick rise then a long fall; note 2: starts lower and falls further.
    carrier.frequency.setValueAtTime(f0 * 0.9, t);
    carrier.frequency.exponentialRampToValueAtTime(f0, t + 0.08);
    carrier.frequency.exponentialRampToValueAtTime(f0 * 0.72, t + 0.55);
    carrier.frequency.setValueAtTime(f0 * 0.78, t + 0.64);
    carrier.frequency.exponentialRampToValueAtTime(f0 * 0.5, t + 1.2);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = rand(140, 200);
    const modDepth = ctx.createGain();
    modDepth.gain.value = rand(60, 120);
    mod.connect(modDepth);
    modDepth.connect(carrier.frequency);
    const amp = ctx.createGain();
    envelope(amp.gain, t, 0.06, 0.22, 0.26, 1);
    const end = envelope(amp.gain, t + 0.64, 0.05, 0.2, 0.36, 0.8);
    carrier.connect(amp);
    amp.connect(voice);
    carrier.start(t);
    mod.start(t);
    carrier.stop(end + 0.03);
    mod.stop(end + 0.03);
  }

  /** Night: a cluster of fast FM blips from one cricket. */
  function cricketCluster(g: Graph, t: number): void {
    const n = g.night;
    if (!n) return;
    const { ctx } = g;
    const voice = ctx.createGain();
    voice.gain.value = rand(0.01, 0.022);
    let tail: AudioNode = voice;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = rand(-0.9, 0.9);
      voice.connect(p);
      tail = p;
    }
    tail.connect(n.out);
    sendToReverb(g, tail, 0.12);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = rand(3900, 4700);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = rand(38, 56);
    const modDepth = ctx.createGain();
    modDepth.gain.value = rand(500, 900);
    mod.connect(modDepth);
    modDepth.connect(carrier.frequency);
    const amp = ctx.createGain();
    amp.gain.value = SILENT;
    const count = 5 + Math.floor(Math.random() * 9);
    const spacing = rand(0.04, 0.062);
    let at = t;
    for (let i = 0; i < count; i++) {
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(1, at + 0.006);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + 0.03);
      at += spacing;
    }
    carrier.connect(amp);
    amp.connect(voice);
    carrier.start(t);
    mod.start(t);
    carrier.stop(at + 0.05);
    mod.stop(at + 0.05);
  }

  /** Night: two soft hoots, a sine with slow vibrato through a dark low-pass. */
  function owlHoot(g: Graph, t: number): void {
    const n = g.night;
    if (!n) return;
    const { ctx } = g;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 720;
    const voice = ctx.createGain();
    voice.gain.value = rand(0.035, 0.06);
    dark.connect(voice);
    let tail: AudioNode = voice;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = rand(-0.7, 0.7);
      voice.connect(p);
      tail = p;
    }
    tail.connect(n.out);
    sendToReverb(g, tail, 0.6);

    const base = rand(300, 370);
    const hoot = (freq: number, at: number, hold: number): number => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const vib = ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = rand(4.5, 6);
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = freq * 0.016;
      vib.connect(vibDepth);
      vibDepth.connect(osc.frequency);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, at, 0.07, hold, 0.24, 1);
      osc.connect(amp);
      amp.connect(dark);
      osc.start(at);
      vib.start(at);
      osc.stop(end + 0.03);
      vib.stop(end + 0.03);
      return end;
    };
    const first = hoot(base, t, 0.16);
    hoot(base * 0.94, first + 0.12, 0.3);
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

    const f = g.frost;
    if (f) {
      f.creakNext = scheduleSparse(f.creakNext, bedActive('frost', now), now, horizon, [1, 5], [4, 14], (at) =>
        iceCreak(g, at),
      );
    }

    const d = g.desert;
    if (d) {
      d.cryNext = scheduleSparse(d.cryNext, bedActive('desert', now), now, horizon, [8, 25], [22, 55], (at) =>
        hawkCry(g, at),
      );
    }

    const n = g.night;
    if (n) {
      const active = bedActive('night', now);
      n.cricketNext = scheduleSparse(n.cricketNext, active, now, horizon, [0.3, 2], [1.4, 4.5], (at) =>
        cricketCluster(g, at),
      );
      n.hootNext = scheduleSparse(n.hootNext, active, now, horizon, [10, 30], [25, 60], (at) => owlHoot(g, at));
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
    if (theme === 'serene' || theme === 'night') {
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
    } else if (theme === 'frost') {
      // Ice: bright shatter plus a couple of cracks.
      noiseBurst(g, g.fxBus, impact, {
        buffer: g.noise.white,
        filter: 'highpass',
        freq: 3200,
        q: 0.8,
        attack: 0.006,
        hold: 0.04,
        release: 0.5,
        peak: 0.24,
        reverb: 0.4,
      });
      tone(g, g.fxBus, impact, { freq: 160, glideTo: 60, glideSeconds: 0.1, attack: 0.004, release: 0.16, peak: 0.18 });
      if (g.frost) {
        for (let i = 0; i < 3; i++) emberClick(g, impact + rand(0.01, 0.2), rand(0.3, 0.7), g.frost.crackFilter);
      }
    } else if (theme === 'desert') {
      // Sand: a dull thud and a short dusty hiss.
      noiseBurst(g, g.fxBus, impact, {
        buffer: g.noise.pink,
        filter: 'lowpass',
        freq: 700,
        q: 0.7,
        attack: 0.01,
        hold: 0.06,
        release: 0.45,
        peak: 0.3,
        reverb: 0.1,
      });
      noiseBurst(g, g.fxBus, impact + 0.03, {
        buffer: g.noise.white,
        filter: 'highpass',
        freq: 5000,
        attack: 0.02,
        hold: 0.1,
        release: 0.35,
        peak: 0.05,
      });
      tone(g, g.fxBus, impact, { freq: 120, glideTo: 55, glideSeconds: 0.12, attack: 0.004, release: 0.2, peak: 0.2 });
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

  /** Rising two-note confirm, brighter than relic (triangle + 2nd/3rd partials, a sparkle on the top note). */
  function playCheckpoint(g: Graph, t: number): void {
    const chime = (freq: number, at: number, amp: number): void => {
      tone(g, g.fxBus, at, { type: 'triangle', freq, attack: 0.003, hold: 0.02, release: 0.5, peak: 0.19 * amp, reverb: 0.35 });
      tone(g, g.fxBus, at, { freq: freq * 2, attack: 0.002, release: 0.25, peak: 0.07 * amp, reverb: 0.3 });
      tone(g, g.fxBus, at, { freq: freq * 3, attack: 0.002, release: 0.12, peak: 0.025 * amp });
    };
    chime(1567.98, t, 0.9); // G6
    chime(2349.32, t + 0.11, 1); // D7, a fifth above
    noiseBurst(g, g.fxBus, t + 0.11, {
      buffer: g.noise.white,
      filter: 'highpass',
      freq: 6500,
      attack: 0.004,
      hold: 0.01,
      release: 0.12,
      peak: 0.04,
      reverb: 0.3,
    });
  }

  /** A short, constant-pitch clock tick: a click through a band-pass plus a tiny wooden body. */
  function playTickWarning(g: Graph, t: number): void {
    const { ctx } = g;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 2.5;
    bp.connect(g.fxBus);
    const src = ctx.createBufferSource();
    src.buffer = g.noise.click;
    const amp = ctx.createGain();
    amp.gain.value = 0.7;
    src.connect(amp);
    amp.connect(bp);
    src.start(t);
    src.stop(t + 0.05);
    tone(g, g.fxBus, t, { type: 'triangle', freq: 1046.5, attack: 0.001, hold: 0.008, release: 0.045, peak: 0.1 });
  }

  /** A soft pulsing hum blip: a low triangle with fast tremolo, through a dark low-pass. */
  function playHillTick(g: Graph, t: number): void {
    const { ctx } = g;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 650;
    dark.Q.value = 0.9;
    dark.connect(g.fxBus);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 164.81; // E3
    const amp = ctx.createGain();
    const end = envelope(amp.gain, t, 0.02, 0.1, 0.16, 0.12);
    const trem = ctx.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = 17;
    const tremDepth = ctx.createGain();
    tremDepth.gain.value = 0.055;
    trem.connect(tremDepth);
    tremDepth.connect(amp.gain);
    osc.connect(amp);
    amp.connect(dark);
    sendToReverb(g, amp, 0.15);
    osc.start(t);
    trem.start(t);
    osc.stop(end + 0.05);
    trem.stop(end + 0.05);
    tone(g, dark, t, { freq: 329.63, attack: 0.03, hold: 0.06, release: 0.12, peak: 0.03 });
  }

  /** A low descending three-note phrase with a long reverb tail. */
  function playLost(g: Graph, t: number): void {
    const { ctx } = g;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 900;
    dark.Q.value = 0.7;
    dark.connect(g.fxBus);
    const notes = [220, 185, 146.83]; // A3 F#3 D3
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1;
      const at = t + i * 0.38;
      tone(g, dark, at, {
        type: 'triangle',
        freq,
        attack: 0.03,
        hold: last ? 0.5 : 0.22,
        release: last ? 1.4 : 0.35,
        peak: 0.16,
        reverb: 0.85,
      });
      tone(g, g.fxBus, at, {
        freq: freq / 2,
        attack: 0.04,
        hold: last ? 0.5 : 0.22,
        release: last ? 1.2 : 0.3,
        peak: 0.07,
        reverb: 0.5,
      });
    });
  }

  /** An airy upward sweep like commit, but longer and softer, with a faint high shimmer. */
  function playBiomeChange(g: Graph, t: number): void {
    noiseBurst(g, g.fxBus, t, {
      buffer: g.noise.white,
      filter: 'bandpass',
      freq: 180,
      sweepTo: 3600,
      sweepSeconds: 1.1,
      q: 1.4,
      attack: 0.4,
      hold: 0.25,
      release: 1.0,
      peak: 0.09,
      reverb: 0.55,
    });
    tone(g, g.fxBus, t + 0.3, { freq: 1318.51, attack: 0.5, hold: 0.3, release: 1.2, peak: 0.03, reverb: 0.8 });
    tone(g, g.fxBus, t + 0.3, { freq: 1975.53, detune: 5, attack: 0.6, hold: 0.3, release: 1.2, peak: 0.02, reverb: 0.8 });
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
    for (const name of THEMES) {
      const target = name === theme ? 1 : 0;
      // Beds that were never built and are not being faded in stay unbuilt.
      const out = bedOut(g, name, target === 1);
      if (!out) continue;
      anchor(out.gain, now);
      out.gain.linearRampToValueAtTime(target, now + dur);
    }
    blendEnd = now + dur;
  }

  /** Output gain of a bed; builds lazily-constructed beds when `create` is set. */
  function bedOut(g: Graph, name: AudioTheme, create: boolean): GainNode | null {
    switch (name) {
      case 'serene':
        return g.serene.out;
      case 'volcanic':
        return g.volcanic.out;
      case 'frost':
        if (!g.frost && create) g.frost = buildFrost(g);
        return g.frost ? g.frost.out : null;
      case 'desert':
        if (!g.desert && create) g.desert = buildDesert(g);
        return g.desert ? g.desert.out : null;
      case 'night':
        if (!g.night && create) g.night = buildNight(g);
        return g.night ? g.night.out : null;
      default:
        return null;
    }
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

    const partial = { ctx, master, bedBus, fxBus, reverb, noise, frost: null, desert: null, night: null } as Graph;
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
    if (!THEMES.includes(next)) return;
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
      case 'checkpoint':
        playCheckpoint(g, t);
        break;
      case 'tick_warning':
        playTickWarning(g, t);
        break;
      case 'hill_tick':
        playHillTick(g, t);
        break;
      case 'lost':
        playLost(g, t);
        break;
      case 'biome_change':
        playBiomeChange(g, t);
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
