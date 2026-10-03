import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HelloMessage } from '@beetle/contracts';
import { describeError, joinWithInvite, type JoinResult } from '../shared/api.ts';
import { useBeetleSocket } from '../shared/use-socket.ts';
import { InputSender } from '../shared/input-sender.ts';
import { Joystick } from './Joystick.tsx';
import { BeetleGlyph } from '../shared/Wordmark.tsx';
import { ObjectiveStrip } from './Objective.tsx';
import { canVibrate, useInHill, useTickCues, vibrate, type FeedbackMode } from './feedback.ts';

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

const STATUS_COPY: Record<string, string> = {
  connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', joining: 'Joining', none: 'Waiting', error: 'Not joined',
};

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
  const { socket, state, rttMs, tick, welcome, world } = view;

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

  // feedback preference: flash always; vibration on top of it when enabled and supported (Android)
  const [feedback, setFeedback] = useState<FeedbackMode>(() => {
    try { return (sessionStorage.getItem('beetle.feedback') as FeedbackMode) || 'flash'; } catch { return 'flash'; }
  });
  const haptics = feedback === 'vibration' && canVibrate;
  const toggleFeedback = () => {
    // user gesture: this is the only place vibration is enabled
    let next: FeedbackMode = feedback === 'vibration' ? 'flash' : 'vibration';
    if (next === 'vibration' && !vibrate(20)) next = 'flash';
    setFeedback(next);
    try { sessionStorage.setItem('beetle.feedback', next); } catch { /* ignore */ }
  };

  const [interactDown, setInteractDown] = useState(false);
  const onInteractDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setInteractDown(true);
    sender.setInteract(true);
    if (haptics) vibrate(12);
  };
  const onInteractUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setInteractDown(false);
    sender.setInteract(false);
  };

  const meId = js.join?.playerId ?? welcome?.playerId ?? null;
  const label = js.join?.label ?? welcome?.playerLabel ?? 'Player';
  const color = js.join?.color ?? welcome?.playerColor ?? '#9fb7b3';
  const status = js.phase !== 'joined' ? js.phase : state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'reconnecting';
  const lag = tick && typeof tick.lastInputSeq === 'number' ? Math.max(0, sender.seq - tick.lastInputSeq) : null;
  const me = tick?.players.find((p) => p.id === meId);

  const cues = useTickCues(tick, meId, haptics);
  const objective = tick?.objective;
  const lost = objective?.lost === true && !tick?.gate.won;
  const won = tick?.gate.won === true;
  const koth = objective?.kind === 'king_of_the_hill';
  const myHold = koth && meId ? objective?.holdSec?.[meId] ?? 0 : 0;
  const holdTarget = koth ? objective?.holdTarget ?? 0 : 0;
  const holdFrac = holdTarget > 0 ? Math.min(1, myHold / holdTarget) : 0;
  const inHill = useInHill(myHold);
  const showHold = koth && (inHill || holdFrac >= 1) && holdFrac > 0;

  const centre = won
    ? 'You did it'
    : lost
      ? 'Time is up'
      : me && me.status !== 'active'
        ? me.status === 'falling' ? 'Falling' : me.status === 'respawning' ? 'Respawning' : 'Disconnected'
        : tick?.gate.unlocked ? 'Gate open. Go.' : '';

  const appClass = [
    'controller-app',
    cues.relic ? 'cue-relic' : '',
    cues.fall ? 'cue-fall' : '',
    cues.win ? 'cue-win' : '',
    won ? 'is-won' : '',
    lost ? 'is-lost' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={appClass} style={{ ['--player' as string]: color }}>
      <div className="ctl-backdrop" aria-hidden="true" />

      <header className="ctl-top ctl-glass">
        <span className="ctl-player">
          <span className="swatch" />
          <span className="ctl-player-name">{label}</span>
        </span>
        <span className={`ctl-status ${status}`}>
          <span className={`dot ${status === 'connected' ? 'on' : status === 'error' ? 'off' : 'warn'}`} />
          <span className="ctl-status-text">{STATUS_COPY[status] ?? status}</span>
          <span className="ctl-net mono">{rttMs === null ? '' : `${Math.round(rttMs)} ms`}{lag !== null && lag > 0 ? ` +${lag}` : ''}</span>
        </span>
        {js.phase === 'joined' && <ObjectiveStrip tick={tick} spec={world?.spec ?? null} meId={meId} />}
        {canVibrate && (
          <button type="button" className="ctl-feedback" onClick={toggleFeedback} aria-pressed={feedback === 'vibration'}>
            {feedback === 'vibration' ? 'Vibration on' : 'Vibration off'}
          </button>
        )}
      </header>

      {js.phase === 'error' && (
        <div className="ctl-error ctl-glass" role="alert">
          <BeetleGlyph size={40} />
          <p>{js.error}</p>
          <p className="muted">Invites expire after five minutes and work once. Ask the director for a new one.</p>
        </div>
      )}
      {js.phase === 'joining' && <div className="ctl-error ctl-glass"><p>Joining</p></div>}

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
            <div className="ctl-hint">Move</div>
          </div>
          <div className={`ctl-centre ${won ? 'won' : lost ? 'lost' : ''}`} aria-live="polite">
            {centre && <span className="ctl-centre-pill ctl-glass">{centre}</span>}
          </div>
          <div className="ctl-right">
            <button
              type="button"
              className={`interact ${interactDown ? 'down' : ''} ${showHold ? 'holding' : ''}`}
              style={{ ['--hold' as string]: holdFrac }}
              onPointerDown={onInteractDown}
              onPointerUp={onInteractUp}
              onPointerCancel={onInteractUp}
              onLostPointerCapture={() => { setInteractDown(false); sender.setInteract(false); }}
              onContextMenu={(e) => e.preventDefault()}
              aria-label={showHold ? `Interact. Holding the hill, ${Math.round(holdFrac * 100)} percent` : 'Interact'}
            >
              <span className="interact-fill" aria-hidden="true" />
              <span className="interact-label">Interact</span>
            </button>
            <div className="ctl-hint">{showHold ? 'Holding the hill' : koth ? 'Stand in the hill' : 'Action'}</div>
          </div>
        </main>
      )}

      <div className="ctl-edge" aria-hidden="true" />
      <div className="ctl-win" aria-hidden={!cues.win}><span>You did it</span></div>
      {lost && js.phase === 'joined' && (
        <div className="ctl-lost" role="status">
          <span className="ctl-lost-title">Time is up</span>
          <span className="ctl-lost-sub">Wait for the director to reset the world</span>
        </div>
      )}
    </div>
  );
}
