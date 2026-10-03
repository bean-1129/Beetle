// Input is a bitmask per fixed tick, so replays are just a list of numbers.
import type { Action, ControlMap } from "../spec/types.ts";

export const BIT: Record<Action, number> = { left: 1, right: 2, up: 4, down: 8, jump: 16, action: 32, pause: 64 };
export const has = (mask: number, a: Action) => (mask & BIT[a]) !== 0;
export const mask = (...actions: Action[]) => actions.reduce((m, a) => m | BIT[a], 0);

// Keyboard, gamepad and touch sources merge into one mask. Remapping edits the ControlMap.
export class InputMapper {
  private keys = new Set<string>();
  // Keys pressed since the last read, so a tap shorter than a frame still registers.
  private tapped = new Set<string>();
  private touch = 0;
  private map: ControlMap;
  constructor(map: ControlMap) {
    this.map = map;
  }
  remap(action: Action, keys: string[]) {
    this.map = { ...this.map, [action]: keys };
  }
  get controls() {
    return this.map;
  }
  keyDown(code: string) {
    this.keys.add(code);
    this.tapped.add(code);
  }
  keyUp(code: string) {
    this.keys.delete(code);
  }
  clear() {
    this.keys.clear();
    this.tapped.clear();
    this.touch = 0;
  }
  setTouch(bits: number) {
    this.touch = bits;
  }
  // pads: a snapshot of navigator.getGamepads() reduced to pressed names ("pad:a", "pad:left").
  read(padButtons: Set<string> = new Set()): number {
    let m = this.touch;
    for (const [action, codes] of Object.entries(this.map) as [Action, string[]][])
      if (codes.some((c) => this.keys.has(c) || this.tapped.has(c) || padButtons.has(c))) m |= BIT[action];
    this.tapped.clear();
    return m;
  }
}

export function padNames(pad: { buttons: readonly { pressed: boolean }[]; axes: readonly number[] } | null): Set<string> {
  const out = new Set<string>();
  if (!pad) return out;
  const b = (i: number) => pad.buttons[i]?.pressed;
  if (b(0)) out.add("pad:a");
  if (b(1)) out.add("pad:b");
  if (b(9)) out.add("pad:start");
  if (b(14) || (pad.axes[0] ?? 0) < -0.4) out.add("pad:left");
  if (b(15) || (pad.axes[0] ?? 0) > 0.4) out.add("pad:right");
  if (b(12) || (pad.axes[1] ?? 0) < -0.4) out.add("pad:up");
  if (b(13) || (pad.axes[1] ?? 0) > 0.4) out.add("pad:down");
  return out;
}
