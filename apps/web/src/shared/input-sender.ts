import type { BeetleSocket } from './ws-client.ts';

export type Axes = { x: number; z: number };

/**
 * Sends { type: 'input' } at most 30 times per second while anything is non-zero,
 * plus one final all-zero message on release. seq is monotonic for the life of the page.
 */
export class InputSender {
  seq = 0;
  private axes: Axes = { x: 0, z: 0 };
  private interact = false;
  private timer: number | null = null;
  private lastWasZero = true;
  private readonly intervalMs = 1000 / 30;

  constructor(private readonly socket: BeetleSocket) {}

  setAxes(x: number, z: number): void {
    this.axes = { x: clamp(x), z: clamp(z) };
    this.schedule();
  }

  setInteract(on: boolean): void {
    this.interact = on;
    this.schedule();
  }

  /** Clears everything and sends one zero message. */
  release(): void {
    this.axes = { x: 0, z: 0 };
    this.interact = false;
    this.flush();
  }

  dispose(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private get isZero(): boolean {
    return this.axes.x === 0 && this.axes.z === 0 && !this.interact;
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
    this.socket.send({
      type: 'input',
      seq: this.seq,
      axes: { x: round(this.axes.x), z: round(this.axes.z) },
      interact: this.interact,
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
