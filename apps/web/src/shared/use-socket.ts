import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentActivity, ControllerStatusMessage, HelloMessage, TickMessage, WelcomeMessage, WorldMessage } from '@beetle/contracts';
import { BeetleSocket, type ConnectionState } from './ws-client.ts';

export type SocketView = {
  socket: BeetleSocket;
  state: ConnectionState;
  rttMs: number | null;
  world: WorldMessage | null;
  /** Throttled to about 10 Hz for React; subscribe to socket.on('tick') for the full rate. */
  tick: TickMessage | null;
  welcome: WelcomeMessage | null;
  activity: AgentActivity[];
  controllers: ControllerStatusMessage['players'];
};

/**
 * React hook around BeetleSocket. The hello builder is read through a ref so callers can pass
 * a fresh closure on every render without reconnecting.
 */
export function useBeetleSocket(hello: () => HelloMessage, enabled = true): SocketView {
  const helloRef = useRef(hello);
  helloRef.current = hello;
  const socket = useMemo(() => new BeetleSocket({ hello: () => helloRef.current() }), []);

  const [state, setState] = useState<ConnectionState>(socket.state);
  const [rttMs, setRtt] = useState<number | null>(null);
  const [world, setWorld] = useState<WorldMessage | null>(null);
  const [tick, setTick] = useState<TickMessage | null>(null);
  const [welcome, setWelcome] = useState<WelcomeMessage | null>(null);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [controllers, setControllers] = useState<ControllerStatusMessage['players']>([]);

  useEffect(() => {
    if (!enabled) return;
    let lastTickPush = 0;
    let pendingTick: TickMessage | null = null;
    let tickTimer: number | null = null;
    const offs = [
      socket.on('state', setState),
      socket.on('rtt', setRtt),
      socket.on('world', setWorld),
      socket.on('welcome', setWelcome),
      socket.on('activity', () => setActivity([...socket.activity])),
      socket.on('controllers', (m) => setControllers(m.players)),
      socket.on('tick', (m) => {
        const now = performance.now();
        if (now - lastTickPush >= 100) {
          lastTickPush = now;
          setTick(m);
        } else {
          pendingTick = m;
          if (tickTimer === null) {
            tickTimer = window.setTimeout(() => {
              tickTimer = null;
              if (pendingTick) { lastTickPush = performance.now(); setTick(pendingTick); pendingTick = null; }
            }, 100);
          }
        }
      }),
    ];
    socket.connect();
    return () => {
      for (const off of offs) off();
      if (tickTimer !== null) clearTimeout(tickTimer);
      socket.close();
    };
  }, [socket, enabled]);

  return { socket, state, rttMs, world, tick, welcome, activity, controllers };
}
