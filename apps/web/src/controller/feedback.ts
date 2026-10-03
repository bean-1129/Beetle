import { useCallback, useEffect, useRef, useState } from 'react';
import type { TickMessage } from '@beetle/contracts';
import { countCollected } from './Objective.tsx';

export type FeedbackMode = 'flash' | 'vibration';
export type Cues = { relic: boolean; fall: boolean; win: boolean };

/** True on Android browsers. iPhone Safari has no vibration API, so the toggle never appears there. */
export const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function vibrate(pattern: number | number[]): boolean {
  if (!canVibrate) return false;
  try { return navigator.vibrate(pattern) === true; } catch { return false; }
}

const DURATION: Record<keyof Cues, number> = { relic: 650, fall: 560, win: 2800 };
const PATTERN: Record<keyof Cues, number | number[]> = { relic: [28, 36, 28], fall: 45, win: [60, 50, 60, 50, 140] };

/**
 * Derives one-shot cues from consecutive ticks for this player: relic count up, started falling, won.
 * The first tick after a (re)connect only seeds the baseline so a reload mid-game stays quiet.
 */
export function useTickCues(tick: TickMessage | null, meId: string | null, haptics: boolean): Cues {
  const [cues, setCues] = useState<Cues>({ relic: false, fall: false, win: false });
  const prev = useRef<{ collected: number; status: string | null; won: boolean } | null>(null);
  const timers = useRef<Partial<Record<keyof Cues, number>>>({});

  const fire = useCallback((k: keyof Cues) => {
    setCues((c) => ({ ...c, [k]: true }));
    const t = timers.current[k];
    if (t) clearTimeout(t);
    timers.current[k] = window.setTimeout(() => setCues((c) => ({ ...c, [k]: false })), DURATION[k]);
  }, []);

  useEffect(() => {
    if (!tick) return;
    const collected = countCollected(tick.relics);
    const me = tick.players.find((p) => p.id === meId);
    const status = me?.status ?? null;
    const won = tick.gate.won;
    const p = prev.current;
    prev.current = { collected, status, won };
    if (!p) return;
    if (collected > p.collected) { fire('relic'); if (haptics) vibrate(PATTERN.relic); }
    if (status === 'falling' && p.status !== 'falling') { fire('fall'); if (haptics) vibrate(PATTERN.fall); }
    if (won && !p.won) { fire('win'); if (haptics) vibrate(PATTERN.win); }
  }, [tick, meId, haptics, fire]);

  useEffect(() => () => { for (const t of Object.values(timers.current)) if (t) clearTimeout(t); }, []);
  return cues;
}

/** Hill presence for king_of_the_hill: the server has no flag, so a rising hold timer means inside. */
export function useInHill(myHold: number): boolean {
  const [inHill, setInHill] = useState(false);
  const last = useRef(myHold);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (myHold > last.current) {
      setInHill(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setInHill(false), 600);
    }
    last.current = myHold;
  }, [myHold]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return inHill;
}
