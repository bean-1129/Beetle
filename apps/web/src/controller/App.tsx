import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HelloMessage } from '@beetle/contracts';
import { describeError, joinWithInvite, type JoinResult } from '../shared/api.ts';
import { useBeetleSocket } from '../shared/use-socket.ts';
import { InputSender } from '../shared/input-sender.ts';
import { Joystick } from './Joystick.tsx';
import { BeetleGlyph } from '../shared/Wordmark.tsx';

type FeedbackMode = 'flash' | 'vibration';
type JoinState = { phase: 'none' | 'joining' | 'joined' | 'error'; join: JoinResult | null; error: string | null };

function storageKey(invite: string) { return `beetle.join.${invite}`; }

function readStoredJoin(invite: string): JoinResult | null {
  try {
    const raw = sessionStorage.getItem(storageKey(invite));
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<JoinResult>;
    if (typeof j.controllerToken === 'string' && typeof j.playerId === 'string') {
      return { controllerToken: j.controllerToken, playerId: j.playerId, label: j.label ?? 'Player', color: j.color ?? '#9fb7b3', slot: j.slot };
    }
  } catch { /* ignore */ }
  return null;
}

export function ControllerApp() {
  const invite = useMemo(() => new URLSearchParams(location.search).get('invite'), []);
  const [js, setJs] = useState<JoinState>(() => {
    if (!invite) return { phase: 'error', join: null, error: 'No invite in the link. Scan the QR on the director or play screen.' };
    const stored = readStoredJoin(invite);
    return stored ? { phase: 'joined', join: stored, error: null } : { phase: 'none', join: null, error: null };
  });
  const joinedOnce = useRef(false);

  useEffect(() => {
    if (!invite || js.phase !== 'none' || joinedOnce.current) return;
    joinedOnce.current = true;
    setJs({ phase: 'joining', join: null, error: null });
    joinWithInvite(invite)
      .then((j) => {
        const join: JoinResult = { controllerToken: j.controllerToken, playerId: j.playerId, label: j.label, color: j.color, slot: j.slot };
        try { sessionStorage.setItem(storageKey(invite), JSON.stringify(join)); } catch { /* ignore */ }
        setJs({ phase: 'joined', join, error: null });
      })
      .catch((err) => setJs({ phase: 'error', join: null, error: describeError(err) }));
  }, [invite, js.phase]);

  const senderRef = useRef<InputSender | null>(null);
  const hello = useCallback((): HelloMessage => ({
    type: 'hello', role: 'controller', token: js.join?.controllerToken ?? 'unset-token', lastSeq: senderRef.current?.seq ?? 0,
  }), [js.join]);
  const view = useBeetleSocket(hello, js.phase === 'joined');
  const { socket, state, rttMs, tick, welcome } = view;

  if (!senderRef.current) senderRef.current = new InputSender(socket);
  const sender = senderRef.current;

  const [resetKey, setResetKey] = useState(0);
  const releaseAll = useCallback(() => {
    sender.release();
    setResetKey((k) => k + 1);
    setInteractDown(false);
  }, [sender]);

  useEffect(() => {
    const onBlur = () => releaseAll();
    const onVis = () => { if (document.visibilityState === 'hidden') releaseAll(); };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    const off = socket.on('state', (s) => { if (s !== 'connected') releaseAll(); });
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      off();
      sender.dispose();
    };
  }, [socket, sender, releaseAll]);

  // feedback preference
  const [feedback, setFeedback] = useState<FeedbackMode>(() => {
    try { return (sessionStorage.getItem('beetle.feedback') as FeedbackMode) || 'flash'; } catch { return 'flash'; }
  });
  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const [flash, setFlash] = useState(false);
  const toggleFeedback = () => {
    // user gesture: this is the only place vibration is enabled
    let next: FeedbackMode = feedback === 'vibration' ? 'flash' : 'vibration';
    if (next === 'vibration') {
      let ok = false;
      try { ok = canVibrate && navigator.vibrate(20) === true; } catch { ok = false; }
      if (!ok) next = 'flash';
    }
    setFeedback(next);
    try { sessionStorage.setItem('beetle.feedback', next); } catch { /* ignore */ }
  };
  const pulse = () => {
    if (feedback === 'vibration' && canVibrate) {
      try { navigator.vibrate(18); return; } catch { /* fall through */ }
    }
    setFlash(true);
    window.setTimeout(() => setFlash(false), 140);
  };

  const [interactDown, setInteractDown] = useState(false);
  const onInteractDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setInteractDown(true);
    sender.setInteract(true);
    pulse();
  };
  const onInteractUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setInteractDown(false);
    sender.setInteract(false);
  };

  const label = js.join?.label ?? welcome?.playerLabel ?? 'Player';
  const color = js.join?.color ?? welcome?.playerColor ?? '#9fb7b3';
  const status = js.phase !== 'joined' ? js.phase : state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'reconnecting';
  const lag = tick && typeof tick.lastInputSeq === 'number' ? Math.max(0, sender.seq - tick.lastInputSeq) : null;
  const me = tick?.players.find((p) => p.id === js.join?.playerId);

  return (
    <div className={`controller-app ${flash ? 'flash' : ''}`}>
      <header className="ctl-top">
        <span className="ctl-player" style={{ ['--player' as string]: color }}>
          <span className="swatch" />
          {label}
        </span>
        <span className="ctl-status">
          <span className={`dot ${status === 'connected' ? 'on' : status === 'error' ? 'off' : 'warn'}`} />
          {status}
        </span>
        <span className="ctl-rtt mono">WebSocket RTT {rttMs === null ? 'n/a' : `${Math.round(rttMs)} ms`}</span>
        <span className="ctl-lag mono" title="inputs sent minus last input the server applied">lag {lag === null ? 'n/a' : lag}</span>
        <button type="button" className="ctl-feedback" onClick={toggleFeedback} aria-pressed={feedback === 'vibration'}>
          {feedback === 'vibration' ? 'Vibration' : 'Flash'}
        </button>
      </header>

      {js.phase === 'error' && (
        <div className="ctl-error" role="alert">
          <BeetleGlyph size={40} />
          <p>{js.error}</p>
          <p className="muted">Invites expire after five minutes and work once. Ask the director for a new one.</p>
        </div>
      )}
      {js.phase === 'joining' && <div className="ctl-error"><p>Joining</p></div>}

      {js.phase === 'joined' && (
        <main className="ctl-controls">
          <div className="ctl-left">
            <Joystick
              radius={60}
              deadZone={0.08}
              resetKey={resetKey}
              onChange={(x, z) => sender.setAxes(x, z)}
              onRelease={() => sender.setAxes(0, 0)}
            />
            <div className="ctl-hint muted">move</div>
          </div>
          <div className="ctl-centre muted">
            {me ? (me.status === 'active' ? '' : me.status) : ''}
            {tick?.gate.won ? 'Gate entered. You won.' : tick?.gate.unlocked ? 'Gate unlocked' : ''}
          </div>
          <div className="ctl-right">
            <button
              type="button"
              className={`interact ${interactDown ? 'down' : ''}`}
              onPointerDown={onInteractDown}
              onPointerUp={onInteractUp}
              onPointerCancel={onInteractUp}
              onLostPointerCapture={() => { setInteractDown(false); sender.setInteract(false); }}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Interact"
            >
              Interact
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
