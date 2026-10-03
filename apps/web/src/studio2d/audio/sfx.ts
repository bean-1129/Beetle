// Procedural sound effects with classic game parameters: square, triangle, saw, sine and noise
// oscillators, pitch slide, vibrato, arpeggio and an attack/sustain/decay envelope. Small,
// instant, and free of licence questions.
import type { SfxPreset } from "../spec/types.ts";
import { mulberry } from "../engine/rng.ts";

export type Wave = "square" | "triangle" | "saw" | "sine" | "noise";
export type SfxParams = {
  wave: Wave;
  freq: number; // Hz at the start
  slide: number; // octaves per second
  duration: number; // seconds
  attack: number;
  decay: number; // fraction of duration spent fading out
  duty: number; // square duty cycle
  vibrato: number; // depth in semitones
  vibratoRate: number;
  arp: number[]; // semitone steps, cycled every arpStep seconds
  arpStep: number;
  volume: number;
  lowpass: number; // 0..1, 1 = open
};

const BASE: Record<SfxPreset, SfxParams> = {
  jump: { wave: "square", freq: 330, slide: 2.2, duration: 0.18, attack: 0.005, decay: 0.7, duty: 0.25, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.35, lowpass: 0.8 },
  coin: { wave: "square", freq: 988, slide: 0, duration: 0.22, attack: 0.002, decay: 0.8, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [0, 5], arpStep: 0.06, volume: 0.3, lowpass: 1 },
  hit: { wave: "noise", freq: 220, slide: -3, duration: 0.2, attack: 0.001, decay: 0.95, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.45, lowpass: 0.55 },
  explosion: { wave: "noise", freq: 110, slide: -1.5, duration: 0.6, attack: 0.002, decay: 0.97, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.55, lowpass: 0.35 },
  powerup: { wave: "triangle", freq: 262, slide: 0, duration: 0.45, attack: 0.01, decay: 0.4, duty: 0.5, vibrato: 0.3, vibratoRate: 10, arp: [0, 4, 7, 12, 16, 19, 24], arpStep: 0.05, volume: 0.35, lowpass: 1 },
  shoot: { wave: "saw", freq: 880, slide: -3.5, duration: 0.14, attack: 0.001, decay: 0.9, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.25, lowpass: 0.6 },
  door: { wave: "triangle", freq: 140, slide: 0.8, duration: 0.3, attack: 0.01, decay: 0.6, duty: 0.5, vibrato: 0.5, vibratoRate: 30, arp: [], arpStep: 0, volume: 0.35, lowpass: 0.7 },
  step: { wave: "noise", freq: 400, slide: 0, duration: 0.05, attack: 0.001, decay: 0.95, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.12, lowpass: 0.3 },
  win: { wave: "square", freq: 523, slide: 0, duration: 0.9, attack: 0.01, decay: 0.3, duty: 0.5, vibrato: 0.2, vibratoRate: 6, arp: [0, 4, 7, 12, 7, 12], arpStep: 0.12, volume: 0.3, lowpass: 0.9 },
  lose: { wave: "triangle", freq: 392, slide: -0.9, duration: 0.9, attack: 0.01, decay: 0.4, duty: 0.5, vibrato: 0.4, vibratoRate: 5, arp: [0, -1, -3, -5], arpStep: 0.2, volume: 0.35, lowpass: 0.8 },
  bounce: { wave: "sine", freq: 180, slide: 3, duration: 0.2, attack: 0.002, decay: 0.8, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.4, lowpass: 1 },
  break: { wave: "noise", freq: 300, slide: -2, duration: 0.25, attack: 0.001, decay: 0.9, duty: 0.5, vibrato: 0, vibratoRate: 0, arp: [], arpStep: 0, volume: 0.4, lowpass: 0.7 },
};

// Seeded variation keeps each game's sounds its own while staying recognisable.
export function sfxParams(preset: SfxPreset, seed: number, overrides: Partial<SfxParams> = {}): SfxParams {
  const r = mulberry(seed);
  const b = BASE[preset];
  return {
    ...b,
    freq: b.freq * (0.85 + r.next() * 0.3),
    slide: b.slide * (0.8 + r.next() * 0.4),
    duration: b.duration * (0.9 + r.next() * 0.2),
    duty: b.wave === "square" ? [0.125, 0.25, 0.5][r.int(0, 2)] : b.duty,
    ...overrides,
  };
}

export function renderSfx(p: SfxParams, sampleRate = 22050): Float32Array {
  const n = Math.max(1, Math.round(p.duration * sampleRate));
  const out = new Float32Array(n);
  const rng = mulberry(Math.round(p.freq * 1000));
  let phase = 0, noise = 0, lp = 0;
  const alpha = Math.min(1, Math.max(0.02, p.lowpass));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let f = p.freq * Math.pow(2, p.slide * t);
    if (p.arp.length && p.arpStep > 0) f *= Math.pow(2, p.arp[Math.floor(t / p.arpStep) % p.arp.length] / 12);
    if (p.vibrato) f *= Math.pow(2, (p.vibrato * Math.sin(2 * Math.PI * p.vibratoRate * t)) / 12);
    f = Math.max(20, Math.min(sampleRate / 2.2, f));
    const prev = phase;
    phase = (phase + f / sampleRate) % 1;
    let v: number;
    switch (p.wave) {
      case "square": v = phase < p.duty ? 1 : -1; break;
      case "triangle": v = 1 - 4 * Math.abs(phase - 0.5); break;
      case "saw": v = 2 * phase - 1; break;
      case "sine": v = Math.sin(2 * Math.PI * phase); break;
      default:
        if (phase < prev) noise = rng.next() * 2 - 1;
        v = noise;
    }
    lp += (v - lp) * alpha;
    const fadeStart = p.duration * (1 - p.decay);
    const env = t < p.attack ? t / p.attack : t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (p.duration - fadeStart));
    out[i] = lp * env * p.volume;
  }
  return out;
}
