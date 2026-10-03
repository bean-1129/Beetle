import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HelloMessage } from '@beetle/contracts';
import { describeError, joinWithInvite, type JoinResult } from '../shared/api.ts';
import { useBeetleSocket } from '../shared/use-socket.ts';
import { PadSender } from './pad-sender.ts';
import { Joystick } from './Joystick.tsx';
import { BeetleGlyph } from '../shared/Wordmark.tsx';
import { ObjectiveStrip } from './Objective.tsx';
import { DPad, Glyph, PadButton, Toggle } from './Pad.tsx';
import { canVibrate, tickSound, useInHill, useTickCues, vibrate, type FeedbackMode } from './feedback.ts';

type JoinState = { phase: 'none' | 'joining' | 'joined' | 'error'; join: JoinResult | null; error: string | null };
type Held = { cross: boolean; circle: boolean; r2: boolean; l2: boolean };
const NONE_HELD: Held = { cross: false, circle: false, r2: false, l2: false };

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

function readFlag(key: string, fallback: boolean): boolean {
  try { const v = sessionStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
function writeFlag(key: string, on: boolean): void {
  try { sessionStorage.setItem(key, on ? '1' : '0'); } catch { /* ignore */ }
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

  const senderRef = useRef<PadSender | null>(null);
  const hello = useCallback((): HelloMessage => ({
    type: 'hello', role: 'controller', token: js.join?.controllerToken ?? 'unset-token', lastSeq: senderRef.current?.seq ?? 0,
  }), [js.join]);
  const view = useBeetleSocket(hello, js.phase === 'joined');
  const { socket, state, rttMs, tick, welcome, world } = view;

  if (!senderRef.current) senderRef.current = new PadSender(socket);
  const sender = senderRef.current;

  // ---- settings: vibration (Android only) and sound ----
  const [feedback, setFeedback] = useState<FeedbackMode>(() => {
    try { return (sessionStorage.getItem('beetle.feedback') as FeedbackMode) || 'flash'; } catch { return 'flash'; }
  });
  const haptics = feedback === 'vibration' && canVibrate;
  const [sound, setSound] = useState(() => readFlag('beetle.ctl.sound', false));
  const [sheetOpen, setSheetOpen] = useState(false);
  const toggleFeedback = () => {
    // user gesture: this is the only place vibration is enabled
    let next: FeedbackMode = feedback === 'vibration' ? 'flash' : 'vibration';
    if (next === 'vibration' && !vibrate(20)) next = 'flash';
    setFeedback(next);
    try { sessionStorage.setItem('beetle.feedback', next); } catch { /* ignore */ }
  };
  const toggleSound = () => { const next = !sound; setSound(next); writeFlag('beetle.ctl.sound', next); if (next) tickSound('tap'); };
  const pressTick = useCallback((kind: 'press' | 'tap' = 'press') => {
    if (haptics) vibrate(kind === 'tap' ? 16 : 10);
    if (sound) tickSound(kind);
  }, [haptics, sound]);

  // ---- axes: stick wins while deflected, otherwise the D-pad ----
  const stickAxes = useRef({ x: 0, z: 0 });
  const dpadAxes = useRef({ x: 0, z: 0 });
  const applyAxes = useCallback(() => {
    const s = stickAxes.current;
    const a = s.x !== 0 || s.z !== 0 ? s : dpadAxes.current;
    sender.setAxes(a.x, a.z);
  }, [sender]);
  const onStick = useCallback((x: number, z: number) => { stickAxes.current = { x, z }; applyAxes(); }, [applyAxes]);
  const onStickRelease = useCallback(() => { stickAxes.current = { x: 0, z: 0 }; applyAxes(); }, [applyAxes]);
  const onDpad = useCallback((x: number, z: number) => { dpadAxes.current = { x, z }; applyAxes(); }, [applyAxes]);

  // ---- buttons ----
  const heldRef = useRef<Held>({ ...NONE_HELD });
  const [held, setHeld] = useState<Held>({ ...NONE_HELD });
  const [tapped, setTapped] = useState<{ ping: boolean; emote: boolean }>({ ping: false, emote: false });
  const tapTimers = useRef<{ ping?: number; emote?: number }>({});
  const syncHeld = useCallback(() => {
    const h = heldRef.current;
    sender.setHeld('interact', h.cross);
    sender.setHeld('sprint', h.circle || h.r2);
    sender.setHeld('slow', h.l2);
    setHeld({ ...h });
  }, [sender]);
  const hold = (k: keyof Held, on: boolean) => {
    if (heldRef.current[k] === on) return;
    heldRef.current[k] = on;
    syncHeld();
    if (on) pressTick();
  };
  const tap = (k: 'ping' | 'emote') => {
    sender.tap(k);
    pressTick('tap');
    setTapped((t) => ({ ...t, [k]: true }));
    const prev = tapTimers.current[k];
    if (prev) clearTimeout(prev);
    tapTimers.current[k] = window.setTimeout(() => setTapped((t) => ({ ...t, [k]: false })), 260);
  };

  const [resetKey, setResetKey] = useState(0);
  const releaseAll = useCallback(() => {
    sender.release();
    stickAxes.current = { x: 0, z: 0 };
    dpadAxes.current = { x: 0, z: 0 };
    heldRef.current = { ...NONE_HELD };
    setHeld({ ...NONE_HELD });
    setResetKey((k) => k + 1);
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
      for (const t of Object.values(tapTimers.current)) if (t) clearTimeout(t);
    };
  }, [socket, sender, releaseAll]);

  // ---- derived view ----
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
  const sprinting = held.circle || held.r2;

  const centre = won
    ? 'You did it'
    : lost
      ? 'Time is up'
      : me && me.status !== 'active'
        ? me.status === 'falling' ? 'Falling' : me.status === 'respawning' ? 'Respawning' : 'Disconnected'
        : showHold ? 'Holding the hill' : tick?.gate.unlocked ? 'Gate open. Go.' : sprinting ? 'Sprinting' : held.l2 ? 'Walking' : '';

  const appClass = [
    'controller-app', 'pad',
    cues.relic ? 'cue-relic' : '',
    cues.fall ? 'cue-fall' : '',
    cues.win ? 'cue-win' : '',
    won ? 'is-won' : '',
    lost ? 'is-lost' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={appClass} style={{ ['--player' as string]: color }}>
      <div className="ctl-backdrop" aria-hidden="true" />

      <header className="pad-shoulders">
        {js.phase === 'joined' ? (
          <PadButton className="trigger trigger-l" label="Walk" ariaLabel="L2, hold to walk slowly" active={held.l2} resetKey={resetKey} onPress={() => hold('l2', true)} onRelease={() => hold('l2', false)}>
            <span className="trigger-key">L2</span>
          </PadButton>
        ) : <span />}

        <div className="touchpad ctl-glass">
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
          <button type="button" className="options" onClick={() => { setSheetOpen(true); pressTick('tap'); }} aria-label="Options" aria-haspopup="dialog" aria-expanded={sheetOpen}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="5" y1="8" x2="19" y2="8" /><line x1="5" y1="12" x2="19" y2="12" /><line x1="5" y1="16" x2="19" y2="16" /></svg>
            <span className="options-label">Options</span>
          </button>
        </div>

        {js.phase === 'joined' ? (
          <PadButton className="trigger trigger-r" label="Sprint" ariaLabel="R2, hold to sprint" active={sprinting} resetKey={resetKey} onPress={() => hold('r2', true)} onRelease={() => hold('r2', false)}>
            <span className="trigger-key">R2</span>
          </PadButton>
        ) : <span />}
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
        <main className="pad-body">
          <div className="pad-left">
            <div className="stick-wrap">
              <Joystick radius={60} deadZone={0.08} resetKey={resetKey} onChange={onStick} onRelease={onStickRelease} />
            </div>
            <DPad onChange={onDpad} onPress={() => pressTick()} resetKey={resetKey} />
          </div>

          <div className={`pad-centre ${won ? 'won' : lost ? 'lost' : ''}`} aria-live="polite">
            {centre && <span className="ctl-centre-pill ctl-glass">{centre}</span>}
          </div>

          <div className="pad-right">
            <div className="diamond" role="group" aria-label="Face buttons">
              <PadButton className="face face-triangle" label="Ping" ariaLabel="Triangle, drop a team beacon" active={tapped.ping} resetKey={resetKey} onPress={() => tap('ping')} onRelease={() => undefined}>
                <Glyph kind="triangle" />
              </PadButton>
              <PadButton className="face face-square" label="Wave" ariaLabel="Square, wave" active={tapped.emote} resetKey={resetKey} onPress={() => tap('emote')} onRelease={() => undefined}>
                <Glyph kind="square" />
              </PadButton>
              <PadButton className="face face-circle" label="Sprint" ariaLabel="Circle, hold to sprint" active={sprinting} resetKey={resetKey} onPress={() => hold('circle', true)} onRelease={() => hold('circle', false)}>
                <Glyph kind="circle" />
              </PadButton>
              <PadButton
                className={`face face-cross ${showHold ? 'holding' : ''}`}
                label="Interact"
                ariaLabel={showHold ? `Cross, interact. Holding the hill, ${Math.round(holdFrac * 100)} percent` : 'Cross, interact'}
                active={held.cross}
                style={{ ['--hold' as string]: holdFrac }}
                resetKey={resetKey}
                onPress={() => hold('cross', true)}
                onRelease={() => hold('cross', false)}
              >
                <span className="interact-fill" aria-hidden="true" />
                <Glyph kind="cross" />
              </PadButton>
            </div>
          </div>
        </main>
      )}

      {sheetOpen && (
        <div className="sheet-scrim" onClick={() => setSheetOpen(false)}>
          <div className="sheet ctl-glass" role="dialog" aria-modal="true" aria-label="Options" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span className="sheet-title">Options</span>
              <button type="button" className="sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close options">Done</button>
            </div>
            <Toggle
              label="Vibration"
              hint={canVibrate ? 'Haptic tick on presses and relic pickups' : 'Not available on this phone. Flash feedback stays on.'}
              on={feedback === 'vibration' && canVibrate}
              onChange={toggleFeedback}
              disabled={!canVibrate}
            />
            <Toggle label="Sound" hint="Soft click on each press" on={sound} onChange={toggleSound} />
            <p className="sheet-note muted">Hold L2 to walk with precision, hold R2 or circle to sprint. Triangle drops a beacon on the big screen, square waves.</p>
          </div>
        </div>
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
