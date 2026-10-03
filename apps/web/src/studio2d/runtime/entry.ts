// Entry point of the exported single-file game: read the embedded spec and play it. Inside
// Beetle 2D the same page runs in a sandboxed frame; the Play view talks to it with messages
// (live spec patches in, game events out).
import type { GameSpec } from "../spec/types.ts";
import { mount, type PlayerEvent } from "./player.ts";
import { makeStreamer } from "../world/levels.ts";
import { ScriptPlayer } from "./script-player.ts";
import { BIT } from "../engine/input.ts";

// Phone pad keys from the studio ({ left, right, up, down, jump, action }) as an action bitmask.
// All false releases every key.
function padBits(keys: unknown): number {
  if (!keys || typeof keys !== "object") return 0;
  const k = keys as Record<string, unknown>;
  let m = 0;
  for (const a of ["left", "right", "up", "down", "jump", "action"] as const) if (k[a] === true) m |= BIT[a];
  return m;
}

const specEl = document.getElementById("studio2d-spec");
const canvas = document.getElementById(
  "studio2d-canvas",
) as HTMLCanvasElement | null;
if (specEl && canvas) {
  const spec = JSON.parse(specEl.textContent || "{}") as GameSpec;
  const embedded = window.parent !== window;
  const tell = (event: PlayerEvent | { type: "ready" }) => {
    if (embedded)
      window.parent.postMessage({ type: "studio2d:event", event }, "*");
  };
  canvas.focus();
  const scripted = spec.script
    ? ((globalThis as any).__studio2dScript ?? {
        broken:
          ((globalThis as any).__studio2dErrors ?? []).join("; ") ||
          "The game code could not load.",
      })
    : null;
  if (scripted) {
    const sp = new ScriptPlayer(canvas, spec, scripted, {
      onEvent: tell,
      skipTitle: embedded,
    });
    sp.start();
    (globalThis as any).__studio2d = sp;
    if (embedded) {
      window.addEventListener("message", (e) => {
        if (e.source !== window.parent) return;
        if (
          e.data?.type === "studio2d:restart" ||
          e.data?.type === "studio2d:level"
        )
          sp.restart();
        else if (e.data?.type === "studio2d:mute")
          sp.mixer.setMuted(!!e.data.muted);
        else if (e.data?.type === "studio2d:focus") canvas.focus();
        else if (e.data?.type === "studio2d:pad") sp.input.setTouch(padBits(e.data.keys));
      });
      tell({ type: "ready" });
    }
  } else {
    const player = mount(canvas, spec, {
      streamer: makeStreamer(spec),
      skipTitle: embedded,
      onEvent: tell,
    });
    if (embedded) {
      window.addEventListener("message", (e) => {
        if (e.source !== window.parent) return;
        const m = e.data;
        if (!m || typeof m !== "object") return;
        if (m.type === "studio2d:spec" && m.spec) {
          player.opts.streamer = makeStreamer(m.spec);
          player.setSpec(m.spec, m.keep !== false);
        } else if (m.type === "studio2d:level" && Number.isInteger(m.level))
          player.startLevel(
            Math.max(0, Math.min(player.spec.levels.length - 1, m.level)),
          );
        else if (m.type === "studio2d:restart") player.restartLevel();
        else if (m.type === "studio2d:mute") player.mixer.setMuted(!!m.muted);
        else if (m.type === "studio2d:focus") canvas.focus();
        else if (m.type === "studio2d:pad") player.setPhoneInput(padBits(m.keys));
      });
      tell({ type: "ready" });
    }
  }
}
