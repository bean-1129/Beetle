import type { AgentPhase } from '@beetle/contracts';

export const PHASE_LABELS: Record<AgentPhase, string> = {
  queued: 'queued',
  planning: 'planning',
  validating: 'validating',
  repairing: 'repairing',
  awaiting_safe_commit: 'awaiting safe commit',
  committed: 'committed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function phaseLabel(phase: string): string {
  return (PHASE_LABELS as Record<string, string>)[phase] ?? phase;
}

export function elapsedSeconds(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return `${(ms / 1000).toFixed(1)} s`;
}

export function msLabel(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
  return `${Math.round(ms)} ms`;
}

export function isFixtureTitle(title: string | undefined): boolean {
  return !!title && title.trim().endsWith('(fixture)');
}

export function stripFixture(title: string): string {
  return title.replace(/\s*\(fixture\)\s*$/, '');
}
