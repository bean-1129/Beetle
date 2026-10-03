# Local-only checklist

Each line states the control, how it is enforced, and how it was verified. Items marked "unverified" have not been tested yet and must not be claimed.

| Control | Enforcement | Verification |
|---|---|---|
| Product inference runs only on the GB10 | The agent refuses any `OLLAMA_BASE_URL` that is not loopback at startup; the only model client in the product is `packages/agent/src/ollama.ts` | `grep -rn "https\?://" packages apps --include=*.ts` shows only loopback and LAN-join URLs (to run before freeze) |
| No cloud fallback | No second provider exists in code or in the isolated OpenClaw config; a missing model returns an error to the director | tests/unit/agent.test.ts case 15 asserts no outbound request to any host but the configured loopback URL |
| Ollama bound to loopback | `OLLAMA_HOST=http://127.0.0.1:11434` (observed in data/logs/ollama-serve.log) | `ss -ltn` shows 127.0.0.1:11434 only |
| OpenClaw gateway and admin on loopback | Isolated home `.openclaw-home/` with gateway bind on loopback | unverified until the agent owner's smoke test |
| Only the web/session app on the team LAN | Server binds `BEETLE_HOST` (0.0.0.0) on port 7700; agent routes additionally require a loopback source address and the agent token | apps/server tests (case 13) |
| Roles enforced | Director token for edits, invites, undo, reports; controller tokens only open a WebSocket for one assigned player; agent token only for loopback agent routes | apps/server tests (case 13) |
| Message limits and rate limits | `SIMULATION.maxMessageBytes`, `inputRateLimitPerSec`, join rate limit 10/min per IP | apps/server tests |
| No model output executed | Model output is parsed into `WorldDraft` or `PatchDraft` with zod and nothing else; no eval, no dynamic import, no shell, no plugin install from model text | code review before freeze |
| No runtime CDN, fonts, analytics | All geometry is procedural, fonts are system fonts, no third-party script tags | `grep -rn "http" apps/web/src apps/web/*.html` before freeze |
| Secrets | `.env` ignored; tokens generated into `data/secrets.json` (ignored, mode 0600); logs use `redactUrl` and the sanitizer redacts token-like keys | review of data/events/*.jsonl after a demo run |
| Offline proof | Run a fresh model-backed edit with the Wi-Fi uplink disconnected (or with outbound traffic blocked by a project-scoped rule) while two phones stay connected on the LAN | unverified; the exact method and result go in BUILD_STATUS.md |
