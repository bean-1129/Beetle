import type { BeetleSocket } from '../shared/ws-client.ts';

export type Axes = { x: number; z: number };
export type HeldButton = 'interact' | 'sprint' | 'slow';
export type TapButton = 'ping' | 'emote';

/**
 * Pad input sender. Same rules as the shared InputSender: at most 30 messages per second while anything
 * is active, one final all-zero message on release, seq monotonic for the life of the page.
 * Every message carries buttons. sprint and slow are held states; ping and emote are edge-triggered and
 * true for exactly one message after a tap.
 */
export class PadSender {
  seq = 0;
  private axes: Axes = { x: 0, z: 0 };
  private held: Record<HeldButton, boolean> = { interact: false, sprint: false, slow: false };
  private pending: Record<TapButton, boolean> = { ping: false, emote: false };
  private timer: number | null = null;
  private lastWasZero = true;
  private readonly intervalMs = 1000 / 30;

  constructor(private readonly socket: BeetleSocket) {}

  setAxes(x: number, z: number): void {
    this.axes = { x: clamp(x), z: clamp(z) };
    this.schedule();
  }

  setHeld(button: HeldButton, on: boolean): void {
    if (this.held[button] === on) return;
    this.held[button] = on;
    this.schedule();
  }

  tap(button: TapButton): void {
    this.pending[button] = true;
    this.schedule();
  }

  /** Clears everything and sends one zero message. */
  release(): void {
    this.axes = { x: 0, z: 0 };
    this.held = { interact: false, sprint: false, slow: false };
    this.pending = { ping: false, emote: false };
    this.flush();
  }

  dispose(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private get isZero(): boolean {
    return this.axes.x === 0 && this.axes.z === 0
      && !this.held.interact && !this.held.sprint && !this.held.slow
      && !this.pending.ping && !this.pending.emote;
  }

  private schedule(): void {
    if (this.timer === null) {
      this.flush();
      this.timer = window.setInterval(() => this.flush(), this.intervalMs);
    }
  }

  private flush(): void {
    const zero = this.isZero;
    if (zero && this.lastWasZero) {
      if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
      return;
    }
    this.seq += 1;
    const buttons = { sprint: this.held.sprint, slow: this.held.slow, ping: this.pending.ping, emote: this.pending.emote };
    this.pending = { ping: false, emote: false };
    this.socket.send({
      type: 'input',
      seq: this.seq,
      axes: { x: round(this.axes.x), z: round(this.axes.z) },
      interact: this.held.interact,
      buttons,
      t: performance.now(),
    });
    this.lastWasZero = zero;
    if (zero && this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
