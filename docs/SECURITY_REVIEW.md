# Security review (Beetle 2D)

Scope: `apps/web/src/studio2d/**`, `apps/web/studio2d.html`, `apps/server/src/studio2d.ts`, the director bootstrap in `apps/server/src/http.ts`. First reviewed 16:03 to 16:15 CDT on 2026-10-03; updated for model-written game code being turned off. Severity: high, medium, low, info.

## Executable-code rule

Rule: runtime model output must never become executable JavaScript.

**Status: complies, with model scripts off.** `MODEL_SCRIPTS_ENABLED = false` (`gen/ai.ts:16`). With it off:

- Ideas that would have taken the scripted route go to a hand-written template (`samples/scripts.ts`, `SCRIPT_TEMPLATES` with `fillTemplate`, which splices only words reduced to `[a-z -]`) or to the closest genre (`ui/Studio2D.tsx:172`, `gen/ai.ts:150`).
- "Change in words" on a template game is refused (`gen/ai.ts:182`); the model never rewrites game code.
- Patch operations under `/script` are refused in `applyPatch` (`spec/patch.ts:56`), closing the second route where a model patch could have added code.

The only JavaScript that runs is the engine, the bundled runtime and the shipped templates. The model writes a design document and patch operations, both parsed with `JSON.parse` and checked by schema and `validateSpec`.

## Findings

| Severity | Where | Issue | Status or fix |
|---|---|---|---|
| resolved (was high) | `gen/ai.ts`, `gen/script.ts`, `export/export.ts` | Model-written JavaScript reached the play frame and exported files. | Route disabled by `MODEL_SCRIPTS_ENABLED = false`. Keep the flag off. If it is ever turned on, all rows below marked "matters if scripts return" become high again. |
| resolved (was medium) | `spec/patch.ts`, `gen/nlpatch.ts` | A model patch could add `/script` and create a scripted game. | `applyPatch` throws on any operation whose first segment is `script`. |
| low (medium if scripts return) | `runtime/script.ts` `checkScript` | Regex denylist, bypassable with computed property access. It is lint, not a boundary. | Applies only to shipped template code today. Do not describe it as containment. |
| low (medium if scripts return) | `export/export.ts`; play iframe in `ui/Studio2D.tsx` | The content security policy (`default-src 'none'`) blocks fetch, XHR, WebSocket, images and fonts but not navigation; an exported file opened from disk has no sandbox. | Exported files contain only the runtime, templates and escaped spec JSON, so no model code runs. Keep it that way. |
| low | `ui/Studio2D.tsx`, `runtime/entry.ts` | `postMessage` uses target origin `"*"` (unavoidable for an opaque-origin frame); inbound source checks are correct; the frame's `studio2d:spec` handler does not re-run `repairSpec`. | Pass a `MessageChannel` port after load; run `repairSpec` in `entry.ts` before `setSpec`. |
| low | `apps/server/src/studio2d.ts` | A closed tab does not abort its Ollama call; the call holds one of the two slots until the 120 s timeout. `/api/2d/warm` is outside the concurrency count. | Abort on request close; count warm in the active total. |
| low | `apps/server/src/studio2d.ts` | `GET /api/2d/status` has no auth; any device that reaches the port can list installed model names. | Require the director token, or return only `online`. |
| low | `apps/server/src/studio2d.ts` | The `schema` field has no size or depth cap before it is forwarded to Ollama as `format`. | Cap the serialized size (for example 8 KB). |
| low | `runtime/player.ts`, `bridge.ts` | localStorage: per-game progress and quick-save snapshots and the library, no size cap, keyed by title. Nothing sensitive stored (no prompts, no tokens). | Cap snapshot size; key by game id. |
| low | `export/export.ts` | `spec.meta.palette[0]` is inserted into `<style>` unescaped; safe only because every caller passes a spec through `repairSpec` (hex check). | Re-check against the hex pattern inside `exportHtml`. |
| info | `apps/server/src/studio2d.ts`, `auth.ts` | Verified good: Ollama URL must be loopback on every request; director token on warm, llm and cancel; strict zod bodies; at most two concurrent calls; 120 s timeout; cancel by id; prompts, replies and tokens never logged. | None. |
| info | `apps/server/src/http.ts` | The director token is handed only to pages opened on this machine (loopback or the machine's own interface address); other devices get 403. | None. |
| info | `studio2d/**` | No external network: no fonts, CDN, analytics or image URLs; art is procedural and images are `data:` URLs. | Confirm with a browser network log during the rehearsal. |

## Not verified

Behaviour in a real browser with a captured network log; the `art` route in `bridge.ts` (no image model is configured, so procedural art is used).
