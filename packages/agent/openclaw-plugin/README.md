# Beetle tools (OpenClaw plugin)

Plugin id `beetle-tools`. Seven agent tools that are thin HTTP clients to the loopback-only Beetle agent routes:
`read_world_state`, `propose_world`, `propose_patch`, `validate_candidate`, `run_playability_checks`,
`commit_candidate`, `publish_build_report`. The server validates every candidate; the plugin never mutates a world.

Built with `defineToolPlugin` from `openclaw/plugin-sdk/tool-plugin` (OpenClaw 2026.9.8). `build.mjs` bundles
`src/index.ts` with the installed esbuild into `dist/index.js` (typebox and zod bundled in, the OpenClaw SDK external),
then `openclaw plugins build --root . --entry ./dist/index.js` generates `openclaw.plugin.json`.

Runtime inputs (all set by the agent worker for one `openclaw agent exec` run):

| Env | Meaning |
|---|---|
| `BEETLE_SERVER_URL` | Beetle server (loopback) |
| `BEETLE_AGENT_TOKEN` | only when `data/secrets.json` (plugin config `secretsPath`) does not hold the token |
| `BEETLE_REQUEST_ID` | the request being processed; tool arguments only fall back to the model's value |
| `BEETLE_OPENCLAW_RUN_FILE` | JSONL evidence file: one line per tool call, commit and report |
| `BEETLE_MAX_TOOL_CALLS` | tool budget per run (default 16) |

Install into the isolated home (what `npm run agent -- --setup-openclaw` does):

```bash
export OPENCLAW_STATE_DIR=$PWD/.openclaw-home OPENCLAW_CONFIG_PATH=$PWD/.openclaw-home/openclaw.json
node packages/agent/openclaw-plugin/build.mjs
openclaw plugins build --root packages/agent/openclaw-plugin --entry ./dist/index.js
openclaw plugins validate --root packages/agent/openclaw-plugin --entry ./dist/index.js
openclaw plugins install ./packages/agent/openclaw-plugin --force --accept-capabilities
openclaw plugins inspect beetle-tools --runtime
```
