// A small procedural composer for game music. Each mood picks a scale, tempo, chord
// progression and groove; the seed picks the melody. Tracks render to one buffer whose end
// joins its start exactly (note tails wrap around), so they loop without a click.
import type { MusicCue, Mood } from "../spec/types.ts";
import { mulberry } from "../engine/rng.ts";

type MoodDef = { tempo: number; scale: number[]; root: number; prog: number[]; lead: "square" | "triangle"; drums: "none" | "soft" | "drive" | "march"; swing: number; density: number };
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10], PENTA = [0, 2, 4, 7, 9];
const MOODS: Record<Mood, MoodDef> = {
  adventure: { tempo: 128, scale: MAJOR, root: 60, prog: [0, 4, 5, 3], lead: "square", drums: "drive", swing: 0, density: 0.7 },
  calm: { tempo: 84, scale: PENTA, root: 62, prog: [0, 3, 4, 3], lead: "triangle", drums: "soft", swing: 0.1, density: 0.45 },
  tense: { tempo: 112, scale: DORIAN, root: 57, prog: [0, 0, 5, 6], lead: "square", drums: "march", swing: 0, density: 0.6 },
  boss: { tempo: 150, scale: MINOR, root: 55, prog: [0, 5, 3, 4], lead: "square", drums: "drive", swing: 0, density: 0.85 },
  victory: { tempo: 120, scale: MAJOR, root: 64, prog: [0, 3, 4, 0], lead: "square", drums: "soft", swing: 0, density: 0.8 },
};

export type Note = { t: number; dur: number; midi: number; voice: "lead" | "bass" | "arp" | "kick" | "snare" | "hat"; vel: number };
export type Score = { tempo: number; beats: number; seconds: number; notes: Note[]; mood: Mood };

export function compose(cue: MusicCue, bars = 8): Score {
  const m = MOODS[cue.mood] ?? MOODS.adventure;
  const rng = mulberry(cue.seed);
  const tempo = cue.tempo ?? m.tempo;
  const beat = 60 / tempo;
  const beats = bars * 4;
  const notes: Note[] = [];
  const degree = (d: number, oct = 0) => {
    const s = m.scale;
    const o = Math.floor(d / s.length);
    return m.root + s[((d % s.length) + s.length) % s.length] + 12 * (o + oct);
  };
  // A motif of 8 eighth-note steps, repeated with variation: memorable, not random.
  const motif = Array.from({ length: 8 }, () => (rng.chance(m.density) ? rng.int(-2, 6) : null));
  for (let bar = 0; bar < bars; bar++) {
    const chord = m.prog[bar % m.prog.length];
    const t0 = bar * 4 * beat;
    // Bass: root on beats 1 and 3, fifth on the offbeats for drive.
    for (let b = 0; b < 4; b++) {
      const d = b % 2 === 0 ? chord : chord + 4;
      notes.push({ t: t0 + b * beat, dur: beat * 0.9, midi: degree(d, -2), voice: "bass", vel: 0.8 });
    }
    // Arpeggio in sixteenths over the chord.
    if (cue.mood !== "calm" || bar % 2 === 0)
      for (let s = 0; s < 16; s += cue.mood === "calm" ? 2 : 1) {
        const d = chord + [0, 2, 4, 7][s % 4];
        notes.push({ t: t0 + (s * beat) / 4, dur: beat / 4, midi: degree(d, 0), voice: "arp", vel: 0.35 });
      }
    // Lead: the motif, shifted to fit the chord, answered on the second half of each phrase.
    const answer = bar % 2 === 1;
    for (let s = 0; s < 8; s++) {
      const step = motif[(s + (answer ? 3 : 0)) % 8];
      if (step === null) continue;
      const sw = s % 2 ? m.swing * beat : 0;
      const d = chord + step + (answer && s > 5 ? -1 : 0);
      const long = s === 7 || (s < 7 && motif[(s + 1) % 8] === null);
      notes.push({ t: t0 + (s * beat) / 2 + sw, dur: (beat / 2) * (long ? 1.8 : 0.9), midi: degree(d, 1), voice: "lead", vel: 0.6 });
    }
    // Drums.
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat;
      if (m.drums === "none") break;
      if (b % 2 === 0 || m.drums === "drive") notes.push({ t, dur: 0.12, midi: 36, voice: "kick", vel: m.drums === "soft" ? 0.5 : 0.9 });
      if (b % 2 === 1 && m.drums !== "soft") notes.push({ t, dur: 0.1, midi: 38, voice: "snare", vel: 0.6 });
      if (m.drums === "march" && b === 3) notes.push({ t: t + beat / 2, dur: 0.1, midi: 38, voice: "snare", vel: 0.4 });
      notes.push({ t: t + beat / 2, dur: 0.04, midi: 42, voice: "hat", vel: 0.3 });
    }
  }
  return { tempo, beats, seconds: beats * beat, notes, mood: cue.mood };
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export function renderScore(score: Score, sampleRate = 22050): Float32Array {
  const n = Math.round(score.seconds * sampleRate);
  const out = new Float32Array(n);
  const lead = MOODS[score.mood]?.lead ?? "square";
  const rng = mulberry(7);
  for (const note of score.notes) {
    const start = Math.round(note.t * sampleRate);
    const len = Math.round(note.dur * sampleRate);
    const f = hz(note.midi);
    let phase = 0, noise = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.005) * Math.max(0, 1 - t / note.dur) ** (note.voice === "lead" ? 0.6 : 1.5);
      let v = 0;
      switch (note.voice) {
        case "lead":
          phase = (phase + f / sampleRate) % 1;
          v = lead === "square" ? (phase < 0.25 ? 0.5 : -0.5) : 1 - 4 * Math.abs(phase - 0.5);
          v *= 0.22;
          break;
        case "bass":
          phase = (phase + f / sampleRate) % 1;
          v = (1 - 4 * Math.abs(phase - 0.5)) * 0.32;
          break;
        case "arp":
          phase = (phase + f / sampleRate) % 1;
          v = (phase < 0.5 ? 0.5 : -0.5) * 0.08;
          break;
        case "kick": {
          const kf = 120 * Math.pow(0.02, t / note.dur) + 40;
          phase = (phase + kf / sampleRate) % 1;
          v = Math.sin(2 * Math.PI * phase) * 0.5;
          break;
        }
        case "snare":
          if (i % 2 === 0) noise = rng.next() * 2 - 1;
          v = noise * 0.22;
          break;
        case "hat":
          noise = rng.next() * 2 - 1;
          v = noise * 0.08;
          break;
      }
      // Wrap tails past the end back to the start: a seamless loop.
      out[(start + i) % n] += v * env * note.vel;
    }
  }
  // Gentle limiter.
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.2) * 0.8;
  return out;
}
