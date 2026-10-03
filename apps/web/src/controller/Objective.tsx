import type { PlayerView, TickMessage, WorldSpec } from '@beetle/contracts';

/** mm:ss, rounded up so the last second reads 00:01 and not 00:00. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function countCollected(relics: TickMessage['relics']): number {
  let n = 0;
  for (const v of Object.values(relics)) if (v === 'collected') n += 1;
  return n;
}

/** Relic display name from the world spec when the controller has one, else the id. */
export function relicName(spec: WorldSpec | null, id: string): string {
  const r = spec?.relics.find((x) => x.id === id);
  return r?.name || id;
}

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

export function HoldRing({ frac, size = 30 }: { frac: number; size?: number }) {
  const f = Math.max(0, Math.min(1, frac));
  return (
    <svg className="ctl-ring" viewBox="0 0 36 36" width={size} height={size} aria-hidden="true">
      <circle className="ctl-ring-track" cx="18" cy="18" r={RING_R} />
      <circle className="ctl-ring-fill" cx="18" cy="18" r={RING_R} style={{ strokeDasharray: RING_C, strokeDashoffset: RING_C * (1 - f) }} />
    </svg>
  );
}

type Props = { tick: TickMessage | null; spec: WorldSpec | null; meId: string | null };

/** Compact objective for the top strip. Everything derives from the tick; the spec only improves names. */
export function ObjectiveStrip({ tick, spec, meId }: Props) {
  if (!tick) return <div className="ctl-objective"><span className="ctl-obj-muted">Waiting for the world</span></div>;
  const obj = tick.objective;
  const kind = obj?.kind ?? 'relic_hunt';
  const collected = countCollected(tick.relics);
  const total = Object.keys(tick.relics).length;
  const required = Math.min(obj?.relicsRequired ?? total, total) || total;
  const won = tick.gate.won;

  const relics = (
    <span className="ctl-obj-relics" aria-label={`Relics ${collected} of ${required}`}>
      <span className="ctl-obj-label">Relics</span>
      <span className="mono ctl-obj-value">{collected}/{required}</span>
    </span>
  );

  if (kind === 'time_trial' || kind === 'survival') {
    const remaining = obj?.remainingSec;
    const lost = obj?.lost === true;
    const tone = lost ? 'lost' : remaining !== undefined && remaining < 10 ? 'danger' : remaining !== undefined && remaining < 20 ? 'warn' : '';
    return (
      <div className={`ctl-objective ${tone}`} data-kind={kind}>
        {relics}
        <span className="ctl-obj-sep" />
        <span className="ctl-obj-clock mono" role="timer" aria-live="off">
          {lost ? 'Time is up' : remaining === undefined ? '--:--' : formatClock(remaining)}
        </span>
        {kind === 'survival' && !lost && <span className="ctl-obj-tag">Survive</span>}
      </div>
    );
  }

  if (kind === 'king_of_the_hill') {
    const hold = obj?.holdSec ?? {};
    const target = obj?.holdTarget ?? 0;
    const mine = meId ? hold[meId] ?? 0 : 0;
    let leader: PlayerView | null = null;
    let best = 0;
    for (const p of tick.players) {
      const h = hold[p.id] ?? 0;
      if (h > best) { best = h; leader = p; }
    }
    const frac = target > 0 ? mine / target : 0;
    return (
      <div className="ctl-objective" data-kind={kind}>
        <span className="ctl-obj-hold">
          <HoldRing frac={frac} />
          <span className="ctl-obj-label">Hold</span>
          <span className="mono ctl-obj-value">{Math.floor(mine)}/{target || '?'} s</span>
        </span>
        <span className="ctl-obj-sep" />
        <span className="ctl-obj-leader">
          <span className="ctl-obj-label">Leader</span>
          {leader
            ? <span className="ctl-obj-value" style={{ color: leader.color }}>{leader.id === meId ? 'You' : leader.label}</span>
            : <span className="ctl-obj-muted">none yet</span>}
        </span>
      </div>
    );
  }

  if (kind === 'checkpoint_race') {
    const next = obj?.nextCheckpointId ?? null;
    return (
      <div className="ctl-objective" data-kind={kind}>
        {relics}
        <span className="ctl-obj-sep" />
        <span className="ctl-obj-next">
          <span className="ctl-obj-label">Next</span>
          <span className="ctl-obj-value">{won ? 'Done' : next ? relicName(spec, next) : tick.gate.unlocked ? 'the gate' : '...'}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="ctl-objective" data-kind={kind}>
      {relics}
      {tick.gate.unlocked && !won && (<><span className="ctl-obj-sep" /><span className="ctl-obj-tag">Gate open</span></>)}
    </div>
  );
}
