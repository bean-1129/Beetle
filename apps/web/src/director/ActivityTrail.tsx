import { useEffect, useRef } from 'react';
import type { AgentActivity } from '@beetle/contracts';
import { elapsedSeconds, phaseLabel } from '../shared/format.ts';

export function ActivityTrail({ entries }: { entries: AgentActivity[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <ol className="activity" ref={listRef} aria-live="polite" aria-label="Agent activity, newest last">
      {entries.length === 0 && <li className="muted">No activity yet. Submit a brief to start the agent.</li>}
      {entries.map((e) => (
        <li key={e.id} className={`activity-item ${e.phase}`}>
          <span className="when mono">{elapsedSeconds(e.elapsedMs)}</span>
          <span className={`phase ${e.phase}`}>{phaseLabel(e.phase)}</span>
          <span className="msg">
            {e.message}
            {e.tool ? <span className="muted"> via {e.tool}</span> : null}
            {e.codes && e.codes.length > 0 ? <span className="codes mono"> {e.codes.join(', ')}</span> : null}
            {e.objectIds && e.objectIds.length > 0 ? <span className="ids mono"> ({e.objectIds.join(', ')})</span> : null}
            {typeof e.worldVersion === 'number' ? <span className="muted"> v{e.worldVersion}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
