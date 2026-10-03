// Clock abstraction so in-process tests can drive time manually.
import { randomBytes } from 'node:crypto';

export type Clock = {
  /** Wall clock milliseconds (Date.now semantics). */
  now(): number;
};

export type FakeClock = Clock & {
  advance(ms: number): void;
  set(ms: number): void;
  readonly fake: true;
};

export const systemClock: Clock = { now: () => Date.now() };

export function createFakeClock(startMs: number = Date.now()): FakeClock {
  let t = startMs;
  return {
    fake: true,
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

export function isFakeClock(clock: Clock): clock is FakeClock {
  return (clock as FakeClock).fake === true;
}

/** Lowercase slug ids that satisfy the contracts IdSchema (prefix + hex). */
export function shortId(prefix: string, bytes = 4): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`;
}

export function hex32(): string {
  return randomBytes(16).toString('hex');
}
