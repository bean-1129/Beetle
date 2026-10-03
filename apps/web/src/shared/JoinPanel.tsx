import { useEffect, useState } from 'react';
import type { ControllerStatusMessage } from '@beetle/contracts';
import { createInvite, describeError, type InviteResult } from './api.ts';
import { qrDataUrl } from './qr.ts';

type Props = {
  token: string;
  controllers?: ControllerStatusMessage['players'];
  compact?: boolean;
};

/** Invite buttons plus QR. Shared by the director panel and the /play page when it has a token. */
export function JoinPanel({ token, controllers = [], compact = false }: Props) {
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [last, setLast] = useState<string>('');

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!invite) { setQr(null); return; }
    qrDataUrl(invite.url).then((u) => { if (!cancelled) setQr(u); }).catch((err) => { if (!cancelled) setError(describeError(err)); });
    return () => { cancelled = true; };
  }, [invite]);

  async function make(slotLabel: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await createInvite(token);
      if (!r || typeof r.url !== 'string') throw new Error('invite response had no url');
      setInvite({ ...r, slot: r.slot ?? undefined });
      setLast(slotLabel);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  const remaining = invite ? Math.max(0, Math.round((invite.expiresAt - now) / 1000)) : 0;

  return (
    <div className="join-panel">
      <h3>Join</h3>
      <div className="row">
        <button type="button" onClick={() => make('Invite player 1')} disabled={busy}>Invite player 1</button>
        <button type="button" onClick={() => make('Invite player 2')} disabled={busy}>Invite player 2</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {invite && (
        <div className="qr-panel">
          {qr ? <img src={qr} alt={`QR code for ${invite.url}`} /> : <div className="muted">rendering QR</div>}
          <div className="url">{invite.url}</div>
          <div className="expires">
            {last ? `${last}. ` : ''}
            {remaining > 0 ? `Expires in ${remaining} s` : 'Expired, invite again'}
            {typeof invite.slot === 'number' ? ` (slot ${invite.slot + 1})` : ''}
          </div>
        </div>
      )}
      {!compact && (
        <ul className="controller-list">
          {controllers.length === 0 && <li className="muted">No controllers yet</li>}
          {controllers.map((c) => (
            <li key={c.id}>
              <span className={`dot ${c.connected ? 'on' : 'off'}`} />
              {c.label}
              <span className="muted"> {c.connected ? 'connected' : 'disconnected'}{c.lastInputAgeMs !== null ? `, input ${Math.round(c.lastInputAgeMs)} ms ago` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
