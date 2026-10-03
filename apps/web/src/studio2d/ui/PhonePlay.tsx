// Play with your phone: join QR codes for Player 1 and Player 2, live connection dots, and a
// display socket that turns relayed phone pad input into the game's own left/right/up/down/jump/action.
import { useEffect, useMemo, useRef, useState } from "react";
import { ROUTES } from "@beetle/contracts";
import type { ControllerStatusMessage, PadMessage } from "@beetle/contracts";
import { BeetleSocket } from "../../shared/ws-client.ts";
import { takeDirectorToken } from "../../shared/token.ts";
import { qrDataUrl } from "../../shared/qr.ts";
import { LoaderCircle, RefreshCw, Smartphone } from "lucide-react";

export type PadKeys = { left: boolean; right: boolean; up: boolean; down: boolean; jump: boolean; action: boolean };
export const NO_KEYS: PadKeys = { left: false, right: false, up: false, down: false, jump: false, action: false };

type Invite = { inviteCode: string; url: string; expiresAt: number; slot?: number };
type SlotState = { invite: Invite | null; qr: string | null; busy: boolean; error: string };

const DEAD = 0.35;
// Codes survive leaving and re-entering Play until they expire, so the phones' QR stays the same.
const cache: ({ invite: Invite; qr: string } | null)[] = [null, null];
const STALE_MS = 1500;
// Genres where the main button jumps; everywhere else it is the action button.
const JUMP_GENRES = new Set(["platformer", "runner"]);

/** Phone pad state to the runtime's actions. z positive is up. */
export function padToKeys(m: Pick<PadMessage, "axes" | "interact" | "buttons">, genre: string): PadKeys {
  const x = m.axes?.x ?? 0;
  const z = m.axes?.z ?? 0;
  const jumpFirst = JUMP_GENRES.has(genre);
  const main = !!m.interact;
  const second = !!m.buttons?.ping;
  return {
    left: x < -DEAD,
    right: x > DEAD,
    up: z > DEAD,
    down: z < -DEAD,
    jump: jumpFirst ? main : second,
    action: jumpFirst ? second : main,
  };
}

const sameKeys = (a: PadKeys, b: PadKeys) => (Object.keys(a) as (keyof PadKeys)[]).every((k) => a[k] === b[k]);

async function makeInvite(token: string, slot: 0 | 1): Promise<Invite> {
  const res = await fetch(ROUTES.directorInvite, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ slot }),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "The director link has expired. Open the studio from a fresh director link." : `The server said ${res.status}.`);
  const r = (await res.json()) as Invite;
  if (!r || typeof r.url !== "string") throw new Error("The invite came back without a link.");
  return r;
}

export function PhonePlay({ genre, onKeys }: { genre: string; onKeys: (keys: PadKeys) => void }) {
  const token = useMemo(() => takeDirectorToken(), []);
  const [slots, setSlots] = useState<SlotState[]>([
    { invite: null, qr: null, busy: false, error: "" },
    { invite: null, qr: null, busy: false, error: "" },
  ]);
  const [controllers, setControllers] = useState<ControllerStatusMessage["players"]>([]);
  const [now, setNow] = useState(Date.now());
  const [online, setOnline] = useState(false);
  const lastPad = useRef<number[]>([0, 0]);
  const slotOf = useRef(new Map<string, 0 | 1>());
  const perSlot = useRef<PadKeys[]>([NO_KEYS, NO_KEYS]);
  const sent = useRef<PadKeys>(NO_KEYS);
  const genreRef = useRef(genre);
  genreRef.current = genre;
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;

  const push = () => {
    // The 2D runtime has one player, so both phones steer it together.
    const [a, b] = perSlot.current;
    const merged: PadKeys = { left: a.left || b.left, right: a.right || b.right, up: a.up || b.up, down: a.down || b.down, jump: a.jump || b.jump, action: a.action || b.action };
    if (sameKeys(merged, sent.current)) return;
    sent.current = merged;
    onKeysRef.current(merged);
  };

  // Display socket while the Play view is open.
  useEffect(() => {
    const sock = new BeetleSocket({ hello: () => ({ type: "hello", role: "display" }) });
    const offs = [
      sock.on("state", (s) => setOnline(s === "connected")),
      sock.on("controllers", (m) => setControllers(m.players)),
      sock.on("message", (m) => {
        if (m.type !== "pad") return;
        const slot: 0 | 1 = m.slot === 1 ? 1 : 0;
        slotOf.current.set(m.playerId, slot);
        lastPad.current[slot] = Date.now();
        perSlot.current[slot] = padToKeys(m, genreRef.current);
        push();
      }),
    ];
    sock.connect();
    // Release keys when a phone goes quiet.
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      for (const s of [0, 1] as const)
        if (n - lastPad.current[s] > STALE_MS && !sameKeys(perSlot.current[s], NO_KEYS)) {
          perSlot.current[s] = NO_KEYS;
          push();
        }
    }, 500);
    return () => {
      clearInterval(t);
      offs.forEach((off) => off());
      sock.close();
      perSlot.current = [NO_KEYS, NO_KEYS];
      push();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSlot = (i: number, patch: Partial<SlotState>) => setSlots((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  async function invite(i: 0 | 1) {
    if (!token) return;
    setSlot(i, { busy: true, error: "" });
    try {
      const r = await makeInvite(token, i);
      const qr = await qrDataUrl(r.url);
      cache[i] = { invite: r, qr };
      setSlot(i, { invite: r, qr, busy: false });
    } catch (e) {
      // Drop the expired code so the refresh does not retry in a loop; the button tries again.
      cache[i] = null;
      setSlot(i, { invite: null, qr: null, busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // First entry to Play with a token: make both codes straight away.
  useEffect(() => {
    if (!token) return;
    for (const i of [0, 1] as const) {
      const c = cache[i];
      if (c && c.invite.expiresAt > Date.now() + 5000) setSlot(i, { invite: c.invite, qr: c.qr });
      else void invite(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Refresh a code when it expires.
  useEffect(() => {
    slots.forEach((s, i) => {
      if (s.invite && !s.busy && s.invite.expiresAt <= now) void invite(i as 0 | 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  const connected = (i: 0 | 1) => {
    if (now - lastPad.current[i] < 4000) return true;
    return controllers.some((c) => c.connected && (slotOf.current.get(c.id) === i || c.label === `Player ${i + 1}`));
  };

  return (
    <section className="bb-phone" aria-label="Play with your phone">
      <div className="bb-phone-head">
        <strong>
          <Smartphone size={14} /> Play with your phone
        </strong>
        <span className={`bb-dot ${online ? "on" : ""}`} title={online ? "Listening for phones" : "Connecting"} />
      </div>
      {!token ? (
        <p className="bb-muted">Open the studio from a director link to show join codes. Phones that already joined still drive the game.</p>
      ) : (
        <div className="bb-phone-grid">
          {([0, 1] as const).map((i) => {
            const s = slots[i];
            const left = s.invite ? Math.max(0, Math.round((s.invite.expiresAt - now) / 1000)) : 0;
            return (
              <div key={i} className="bb-phone-slot">
                <div className="bb-phone-slot-head">
                  <span className={`bb-dot ${connected(i) ? "on" : ""}`} />
                  <span>Player {i + 1}</span>
                  <em className="bb-muted">{connected(i) ? "connected" : "waiting"}</em>
                </div>
                {s.qr && s.invite ? (
                  <>
                    <img src={s.qr} alt={`QR code to join as Player ${i + 1}`} />
                    <a className="bb-phone-url mono" href={s.invite.url} target="_blank" rel="noreferrer">
                      {s.invite.url}
                    </a>
                    <span className="bb-muted">{left > 0 ? `Code refreshes in ${left} s` : "Refreshing"}</span>
                  </>
                ) : (
                  <div className="bb-phone-empty">{s.busy ? <LoaderCircle size={16} className="spin" /> : null}</div>
                )}
                {s.error && <span className="bb-phone-error">{s.error}</span>}
                <button className="secondary-button bb-small" disabled={s.busy} onClick={() => void invite(i)}>
                  <RefreshCw size={13} /> {s.invite ? "New code" : `Invite Player ${i + 1}`}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="bb-muted">Stick moves, the main button {JUMP_GENRES.has(genre) ? "jumps" : "acts"}, the triangle {JUMP_GENRES.has(genre) ? "acts" : "jumps"}. Both phones steer the same hero.</p>
    </section>
  );
}
