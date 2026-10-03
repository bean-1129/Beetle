// Cutout animation: a character is drawn once as separate parts (body, head, legs, tail,
// wings), then animated by moving and rotating those parts with keyframes. Every frame
// uses the same pixels, so characters stay perfectly consistent.
import { pixels, put, get, type Pixels } from "./pixels.ts";

export type Part = { name: string; img: Pixels; pivot: [number, number]; at: [number, number]; z: number };
export type Rig = { w: number; h: number; parts: Part[]; archetype: string };
export type Pose = Record<string, { r?: number; dx?: number; dy?: number; sx?: number; sy?: number }>;
export type Anim = "idle" | "walk" | "run" | "jump" | "fall" | "hurt" | "attack";
export const ANIMS: Anim[] = ["idle", "walk", "run", "jump", "fall", "hurt", "attack"];
export const FRAME_COUNT: Record<Anim, number> = { idle: 4, walk: 6, run: 6, jump: 1, fall: 1, hurt: 2, attack: 3 };
export const FRAME_TIME: Record<Anim, number> = { idle: 0.18, walk: 0.1, run: 0.07, jump: 1, fall: 1, hurt: 0.1, attack: 0.08 };

// Deterministic sine table for poses (asset time only, never in the simulation).
const wave = (t: number) => Math.sin(t * Math.PI * 2);

export function poseFor(archetype: string, anim: Anim, phase: number): Pose {
  const s = wave(phase), c = wave(phase + 0.25);
  const deg = (d: number) => (d * Math.PI) / 180;
  switch (archetype) {
    case "quadruped": {
      const swing = anim === "run" ? 38 : anim === "walk" ? 24 : 0;
      const bob = anim === "idle" ? s * 0.5 : anim === "walk" || anim === "run" ? Math.abs(s) * -1 : 0;
      const pose: Pose = {
        body: { dy: bob },
        head: { dy: bob + (anim === "idle" ? c * 0.4 : 0), r: anim === "hurt" ? deg(-18) : anim === "attack" ? deg(10) : 0 },
        tail: { r: deg(anim === "idle" ? s * 12 : anim === "jump" ? -25 : anim === "fall" ? 20 : s * 18), dy: bob },
        legFrontNear: { r: deg(swing * s) },
        legFrontFar: { r: deg(-swing * s) },
        legBackNear: { r: deg(-swing * s) },
        legBackFar: { r: deg(swing * s) },
        ear: { dy: bob, r: anim === "hurt" ? deg(-20) : 0 },
      };
      if (anim === "jump") Object.assign(pose, { legFrontNear: { r: deg(-40) }, legFrontFar: { r: deg(-30) }, legBackNear: { r: deg(35) }, legBackFar: { r: deg(25) } });
      if (anim === "fall") Object.assign(pose, { legFrontNear: { r: deg(20) }, legFrontFar: { r: deg(10) }, legBackNear: { r: deg(-15) }, legBackFar: { r: deg(-10) } });
      if (anim === "attack") pose.body = { dx: 1 + phase * 2 };
      return pose;
    }
    case "biped": {
      const swing = anim === "run" ? 45 : anim === "walk" ? 28 : 0;
      const bob = anim === "idle" ? s * 0.5 : anim === "walk" || anim === "run" ? -Math.abs(s) : 0;
      const pose: Pose = {
        body: { dy: bob },
        head: { dy: bob + (anim === "idle" ? c * 0.3 : 0), r: anim === "hurt" ? deg(-15) : 0 },
        hat: { dy: bob, r: anim === "hurt" ? deg(-15) : 0 },
        armNear: { r: deg(-swing * s) + (anim === "attack" ? deg(-80 + phase * 60) : 0) + (anim === "jump" ? deg(-120) : 0), dy: bob },
        armFar: { r: deg(swing * s) + (anim === "jump" ? deg(-100) : 0), dy: bob },
        legNear: { r: deg(swing * s) + (anim === "jump" ? deg(-30) : 0) },
        legFar: { r: deg(-swing * s) + (anim === "jump" ? deg(20) : 0) },
      };
      return pose;
    }
    case "flyer": {
      const flap = anim === "hurt" ? 0 : s * 40;
      return {
        body: { dy: c * 1.2 },
        head: { dy: c * 1.2 },
        wingNear: { r: deg(flap), dy: c * 1.2 },
        wingFar: { r: deg(-flap * 0.8), dy: c * 1.2 },
        tail: { r: deg(s * 10), dy: c * 1.2 },
      };
    }
    case "blob": {
      const squash = anim === "idle" ? 1 + s * 0.06 : anim === "walk" || anim === "run" ? 1 + s * 0.14 : anim === "jump" ? 0.85 : anim === "fall" ? 1.1 : 1;
      return { body: { sy: squash, sx: 2 - squash }, eyes: { dy: (1 - squash) * 6 } };
    }
    case "bug": {
      const swing = anim === "walk" || anim === "run" ? 30 : 6;
      return {
        body: { dy: anim === "idle" ? s * 0.4 : 0 },
        legA: { r: deg(swing * s) },
        legB: { r: deg(-swing * s) },
        legC: { r: deg(swing * s) },
        head: { r: anim === "hurt" ? deg(-15) : 0 },
      };
    }
    default:
      return {};
  }
}

// Draw one frame of a rig into a pixel buffer (nearest-neighbour rotation, so pixel art
// stays crisp).
export function renderRig(rig: Rig, pose: Pose): Pixels {
  const out = pixels(rig.w, rig.h);
  const parts = rig.parts.slice().sort((a, b) => a.z - b.z);
  for (const part of parts) {
    const t = pose[part.name] || (part.name.startsWith("leg") || part.name.startsWith("arm") || part.name.startsWith("wing") ? {} : pose.body) || {};
    const r = t.r ?? 0, sx = t.sx ?? 1, sy = t.sy ?? 1;
    const cos = Math.cos(r), sin = Math.sin(r);
    const ax = part.at[0] + (t.dx ?? 0), ay = part.at[1] + (t.dy ?? 0);
    const [px, py] = part.pivot;
    // Bounding box of the transformed part.
    const corners = [[-px, -py], [part.img.w - px, -py], [-px, part.img.h - py], [part.img.w - px, part.img.h - py]].map(([x, y]) => [
      ax + (x * sx) * cos - (y * sy) * sin,
      ay + (x * sx) * sin + (y * sy) * cos,
    ]);
    const x0 = Math.floor(Math.min(...corners.map((c) => c[0]))), x1 = Math.ceil(Math.max(...corners.map((c) => c[0])));
    const y0 = Math.floor(Math.min(...corners.map((c) => c[1]))), y1 = Math.ceil(Math.max(...corners.map((c) => c[1])));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - ax, dy = y + 0.5 - ay;
        const lx = (dx * cos + dy * sin) / sx + px, ly = (-dx * sin + dy * cos) / sy + py;
        const ix = Math.floor(lx), iy = Math.floor(ly);
        if (ix < 0 || iy < 0 || ix >= part.img.w || iy >= part.img.h) continue;
        const c = get(part.img, ix, iy);
        if (c[3]) put(out, x, y, c);
      }
  }
  return out;
}

export function bakeRig(rig: Rig): Record<Anim, Pixels[]> {
  const out = {} as Record<Anim, Pixels[]>;
  for (const a of ANIMS) {
    const n = FRAME_COUNT[a];
    out[a] = Array.from({ length: n }, (_, i) => renderRig(rig, poseFor(rig.archetype, a, n === 1 ? 0 : i / n)));
  }
  // The hurt pose flashes: its second frame is lightened.
  const flash = out.hurt[1];
  for (let i = 0; i < flash.data.length; i += 4) if (flash.data[i + 3]) for (let k = 0; k < 3; k++) flash.data[i + k] = 255 - (255 - flash.data[i + k]) * 0.35;
  return out;
}
