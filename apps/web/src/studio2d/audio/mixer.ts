// Web Audio mixer for games: sound effects and looping music on separate gain buses. Buffers
// are rendered once from the spec (no files, no network) and cached.
import type { GameSpec, SfxPreset } from "../spec/types.ts";
import { renderSfx, sfxParams } from "./sfx.ts";
import { compose, renderScore } from "./music.ts";

const SR = 22050;
// Engine events and the sound each one plays.
export const EVENT_SFX: Record<string, SfxPreset> = {
  jump: "jump", coin: "coin", powerup: "powerup", hit: "hit", defeat: "explosion", stomp: "bounce", die: "lose",
  shoot: "shoot", door: "door", "switch-on": "door", break: "break", bounce: "bounce", checkpoint: "powerup",
  win: "win", lose: "lose", push: "step", step: "step", goal: "win", go: "jump", spawn: "step", crumble: "break",
};

export class Mixer {
  ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private music: { id: string; node: AudioBufferSourceNode } | null = null;
  private spec: GameSpec;
  muted = false;
  sfxVolume = 0.8;
  musicVolume = 0.45;
  private last = new Map<string, number>();

  constructor(spec: GameSpec) {
    this.spec = spec;
  }
  setSpec(spec: GameSpec) {
    if (JSON.stringify(spec.audio) !== JSON.stringify(this.spec.audio)) this.buffers.clear();
    this.spec = spec;
  }
  // Must be called from a user gesture the first time.
  resume() {
    const AC: typeof AudioContext | undefined = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this.sfxBus = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus.connect(this.ctx.destination);
      this.musicBus.connect(this.ctx.destination);
      this.applyVolumes();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }
  applyVolumes() {
    if (!this.ctx) return;
    this.sfxBus!.gain.value = this.muted ? 0 : this.sfxVolume;
    this.musicBus!.gain.value = this.muted ? 0 : this.musicVolume;
  }
  setMuted(m: boolean) {
    this.muted = m;
    this.applyVolumes();
  }
  private buffer(key: string, make: () => Float32Array): AudioBuffer | null {
    if (!this.ctx) return null;
    let b = this.buffers.get(key);
    if (!b) {
      const data = make();
      b = this.ctx.createBuffer(1, data.length, SR);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(key, b);
    }
    return b;
  }
  playEvent(type: string) {
    const preset = EVENT_SFX[type];
    if (!preset) return;
    // Some events (steps) fire every few frames; keep them from stacking.
    const now = this.ctx?.currentTime ?? 0;
    if ((this.last.get(preset) ?? -1) > now - 0.05) return;
    this.last.set(preset, now);
    this.play(preset);
  }
  play(preset: SfxPreset) {
    if (!this.ctx || this.muted) return;
    const ref = this.spec.audio.sfx[preset] ?? { preset, seed: 1 };
    const b = this.buffer(`sfx:${preset}:${ref.seed}`, () => renderSfx(sfxParams(ref.preset, ref.seed, ref.params as any), SR));
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.connect(this.sfxBus!);
    src.start();
  }
  playMusic(id: string | undefined) {
    if (!this.ctx) return;
    if (this.music?.id === id) return;
    this.stopMusic();
    const cue = this.spec.audio.music.find((m) => m.id === id) ?? this.spec.audio.music[0];
    if (!cue) return;
    const b = this.buffer(`music:${cue.id}:${cue.seed}:${cue.mood}:${cue.tempo ?? ""}`, () => renderScore(compose(cue), SR));
    if (!b) return;
    const node = this.ctx.createBufferSource();
    node.buffer = b;
    node.loop = true;
    node.loopStart = 0;
    node.loopEnd = b.duration;
    node.connect(this.musicBus!);
    node.start();
    this.music = { id: id ?? cue.id, node };
  }
  stopMusic() {
    try {
      this.music?.node.stop();
    } catch {}
    this.music = null;
  }
  destroy() {
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = null;
  }
}
