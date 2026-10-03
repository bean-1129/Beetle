// Compact agent-facing summary. Positions are reduced to a surface id; no raw coordinates, no tokens.
import type { SessionState, SessionSummary } from '@beetle/contracts';
import type { CompiledWorld } from './types.ts';

export function buildSessionSummary(
  compiled: CompiledWorld,
  session: Pick<SessionState, 'worldVersion' | 'elapsedMs' | 'players' | 'collectedRelicIds' | 'gateUnlocked' | 'won' | 'score'>,
): SessionSummary {
  const spec = compiled.spec;
  const collected = new Set(session.collectedRelicIds);
  const islands = compiled.surfaces.filter((s) => s.kind === 'island');
  const bridges = compiled.surfaces.filter((s) => s.kind === 'bridge');
  return {
    worldVersion: session.worldVersion,
    worldTitle: spec.title,
    elapsedSec: Math.round(session.elapsedMs / 100) / 10,
    players: session.players.map((p) => ({
      id: p.id,
      label: p.label,
      onSurfaceId: p.status === 'falling' ? null : (p.supportId ?? compiled.supportAt(p.x, p.z)),
      status: p.status,
      connected: p.connected,
    })),
    collectedRelicIds: spec.relics.filter((r) => collected.has(r.id)).map((r) => r.id),
    remainingRelicIds: spec.relics.filter((r) => !collected.has(r.id)).map((r) => r.id),
    gateUnlocked: session.gateUnlocked,
    won: session.won,
    score: session.score,
    islands: islands.map((is) => ({
      id: is.id,
      name: is.name,
      compass: is.compass,
      bridgeIds: bridges.filter((b) => b.islandIds[0] === is.id || b.islandIds[1] === is.id).map((b) => b.id),
    })),
  };
}
