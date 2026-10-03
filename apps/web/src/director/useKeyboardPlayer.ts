import { useCallback, useEffect, useRef, useState } from 'react';
import { createInvite, describeError, joinWithInvite, type JoinResult } from '../shared/api.ts';
import { BeetleSocket, type ConnectionState } from '../shared/ws-client.ts';
import { InputSender } from '../shared/input-sender.ts';

export type KeyboardPlayerState = {
  phase: 'idle' | 'joining' | 'active' | 'error';
  connection: ConnectionState;
  label: string | null;
  color: string | null;
  error: string | null;
  seq: number;
  lastInputSeq: number | null;
};

const MOVE_KEYS: Record<string, { x: number; z: number }> = {
  KeyW: { x: 0, z: 1 }, ArrowUp: { x: 0, z: 1 },
  KeyS: { x: 0, z: -1 }, ArrowDown: { x: 0, z: -1 },
  KeyA: { x: -1, z: 0 }, ArrowLeft: { x: -1, z: 0 },
  KeyD: { x: 1, z: 0 }, ArrowRight: { x: 1, z: 0 },
};
const INTERACT_KEYS = new Set(['KeyE', 'Space']);

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/**
 * "Keyboard player": creates an invite, joins it, opens a second WebSocket as a controller and maps
 * WASD/arrows to axes and E/Space to interact, so the demo can be recorded without phones.
 */
export function useKeyboardPlayer(token: string | null) {
  const [state, setState] = useState<KeyboardPlayerState>({ phase: 'idle', connection: 'closed', label: null, color: null, error: null, seq: 0, lastInputSeq: null });
  const socketRef = useRef<BeetleSocket | null>(null);
  const senderRef = useRef<InputSender | null>(null);
  const pressed = useRef<Set<string>>(new Set());
  const joinRef = useRef<JoinResult | null>(null);

  const stop = useCallback(() => {
    senderRef.current?.release();
    senderRef.current?.dispose();
    senderRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    pressed.current.clear();
    joinRef.current = null;
    setState({ phase: 'idle', connection: 'closed', label: null, color: null, error: null, seq: 0, lastInputSeq: null });
  }, []);

  const start = useCallback(async () => {
    if (!token) { setState((s) => ({ ...s, phase: 'error', error: 'No director token' })); return; }
    stop();
    setState((s) => ({ ...s, phase: 'joining', error: null }));
    try {
      const invite = await createInvite(token);
      const join = await joinWithInvite(invite.inviteCode);
      joinRef.current = join;
      const socket = new BeetleSocket({
        hello: () => ({ type: 'hello', role: 'controller', token: join.controllerToken, lastSeq: senderRef.current?.seq ?? 0 }),
      });
      const sender = new InputSender(socket);
      socketRef.current = socket;
      senderRef.current = sender;
      socket.on('state', (c) => {
        if (c !== 'connected') { sender.release(); pressed.current.clear(); }
        setState((s) => ({ ...s, connection: c }));
      });
      socket.on('tick', (t) => {
        if (typeof t.lastInputSeq === 'number') {
          setState((s) => (s.lastInputSeq === t.lastInputSeq && s.seq === sender.seq ? s : { ...s, lastInputSeq: t.lastInputSeq ?? null, seq: sender.seq }));
        }
      });
      socket.connect();
      setState({ phase: 'active', connection: socket.state, label: join.label, color: join.color, error: null, seq: 0, lastInputSeq: null });
    } catch (err) {
      setState((s) => ({ ...s, phase: 'error', error: describeError(err) }));
    }
  }, [token, stop]);

  useEffect(() => {
    const recompute = () => {
      const sender = senderRef.current;
      if (!sender) return;
      let x = 0; let z = 0;
      for (const code of pressed.current) {
        const v = MOVE_KEYS[code];
        if (v) { x += v.x; z += v.z; }
      }
      const m = Math.hypot(x, z);
      if (m > 1) { x /= m; z /= m; }
      sender.setAxes(x, z);
      let interact = false;
      for (const code of pressed.current) if (INTERACT_KEYS.has(code)) interact = true;
      sender.setInteract(interact);
      setState((s) => (s.seq === sender.seq ? s : { ...s, seq: sender.seq }));
    };
    const onDown = (e: KeyboardEvent) => {
      if (!senderRef.current || isEditable(e.target)) return;
      if (!(e.code in MOVE_KEYS) && !INTERACT_KEYS.has(e.code)) return;
      e.preventDefault();
      if (e.repeat) return;
      pressed.current.add(e.code);
      recompute();
    };
    const onUp = (e: KeyboardEvent) => {
      if (!senderRef.current) return;
      if (!pressed.current.has(e.code)) return;
      pressed.current.delete(e.code);
      recompute();
    };
    const onBlur = () => { pressed.current.clear(); senderRef.current?.release(); };
    const onVis = () => { if (document.visibilityState === 'hidden') onBlur(); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { state, start, stop };
}
