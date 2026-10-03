// Small deterministic random source (mulberry32). Its whole state is one integer, so it
// snapshots with the game and replays exactly.
export function mulberry(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    range: (lo: number, hi: number) => lo + next() * (hi - lo),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    get state() {
      return s;
    },
    set state(v: number) {
      s = v >>> 0;
    },
  };
}
export type Rng = ReturnType<typeof mulberry>;

// Deterministic smooth wave in [0,1] without trig, so kinematic motion is identical everywhere.
export function pingPong(t: number): number {
  const f = t - Math.floor(t);
  const tri = f < 0.5 ? f * 2 : 2 - f * 2;
  return tri * tri * (3 - 2 * tri);
}
