# @beetle/agent

The Beetle agent worker: claims director requests from the Beetle server, runs one bounded job per request and
reports the outcome. Two modes, both labelled in every status message, report and event:

- `openclaw` (submission path): the request is handed to the installed OpenClaw (`openclaw agent exec`) running in
  the isolated home `.openclaw-home/` with the Beetle tool plugin (`packages/agent/openclaw-plugin`). The model inside
  OpenClaw calls the seven Beetle tools; each tool call is an HTTP request to the loopback agent routes.
- `direct` (dev harness and labelled fallback): the same seven tool functions are called in-process and the model is
  driven through Ollama `/api/chat` with `format` set to the contract JSON schemas, `think: false`, `stream: false`.

Nothing from the model is ever executed. Model output is parsed as JSON (syntax and truncation only) and sent to the
server, which normalizes and validates it with the contract schemas; validator issues (codes, object ids, evidence)
are quoted back verbatim for a bounded repair.

## Commands

```bash
export PATH=$PWD/.tools/node/bin:$PWD/.tools/npm-global/bin:$PATH
npm run agent -- --health                      # model, server and OpenClaw setup reachability
npm run agent -- --mode openclaw --setup-openclaw   # build the plugin, write .openclaw-home/openclaw.json, install the plugin
npm run agent -- --mode openclaw               # worker loop (default mode from BEETLE_AGENT_MODE)
npm run agent -- --mode direct --once          # process one request in direct mode and exit
npx vitest run tests/unit/agent.test.ts        # cases 14 and 15 with a fake Ollama and a fake Beetle server
npx tsx scripts/benchmark-local.ts             # direct-mode model benchmark, writes data/benchmarks/
```

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `BEETLE_AGENT_MODE` | `openclaw` | `openclaw` or `direct` |
| `BEETLE_SERVER_URL` | `http://127.0.0.1:7700` | loopback only; anything else is refused at startup |
| `BEETLE_AGENT_TOKEN` | from `data/secrets.json` | agent token for the loopback agent routes |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | loopback only; anything else is refused at startup |
| `BEETLE_MODEL` | `qwen3.5:4b` | the one allowed model |
| `BEETLE_REQUEST_DEADLINE_MS` | `120000` | per-request deadline |
| `BEETLE_MAX_REPAIR_ATTEMPTS` | `2` | bounded validator-driven repairs |
| `BEETLE_MAX_TOOL_CALLS` | `16` | bounded tool calls per job (also enforced inside the plugin) |
| `OPENCLAW_HOME` | `<repo>/.openclaw-home` | isolated OpenClaw state dir and config path |

## Files

- `src/config.ts` env loading, loopback checks, token from `data/secrets.json`
- `src/ollama.ts` `/api/chat` client (format, tools, think false, stream false, timeouts), `parseModelJson`
- `src/tools.ts` the seven tools as thin HTTP clients plus claim/status/finish; records `{ tool, ok, ms }`
- `src/prompts.ts` system prompts (coordinate convention, limits, island table, repair instructions), OpenClaw instruction prompt
- `src/jobs.ts` the bounded job (deadline, repairs, tool budget, cancellation, OCCUPIED_SUPPORT retry)
- `src/direct.ts`, `src/openclaw.ts`, `src/worker.ts`, `src/main.ts`
- `openclaw-plugin/` the OpenClaw tool plugin package (`defineToolPlugin`, bundled with esbuild)
- `test-support/` fake Beetle server, fake Ollama, fixture world
- `SMOKE.md` evidence from the real OpenClaw smoke test against the fake server
