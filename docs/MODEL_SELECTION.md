# Model selection for the Beetle demo

Status: written 2026-10-03 13:22 CDT. Every number below is copied from a run file or log named in the table it
appears in; nothing is estimated. Section 9 is appended later if qwen3.8:27b lands before 14:10 CDT.

Decision (as of 13:25 CDT): the demo runs on qwen3.5:4b (Q4_K_M). qwen3.8:27b has not been benchmarked because its
pull failed (section 6); the 4b is selected on measured time to a valid result, not on size.

## 1. Rule applied

The brief selects on correct task completion latency: the time from request to a result that passes the schema and
validator, including repair rounds, not raw tokens per second and not model size. The engineering target for a small
world (brief to valid draft) is roughly 10 s warm. That is a target, not a claim: neither model has been shown to meet
it (section 4).

## 2. Environment observed

| Item | Value | Source |
|---|---|---|
| Machine | NVIDIA GB10, unified memory; `nvidia-smi` reports GPU memory as "Not Supported", so memory use comes from `nvidia-smi --query-compute-apps`, `ollama ps` and `free -g` | `nvidia-smi` 12:51 CDT |
| System memory | 121 GiB total; 10 to 16 GiB used, 105 to 110 GiB available with qwen3.5:4b resident | `free -g` 12:51 and 13:03 CDT |
| Ollama (first daemon, 11:16 to 13:03 CDT) | 0.35.1, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_FLASH_ATTENTION=false`; llama-server started with `-c 8192 -np 1 --flash-attn auto` | `data/logs/ollama-serve.log` |
| Ollama (second daemon, restarted by another owner at 13:03:17 CDT) | 0.35.1, `OLLAMA_NUM_PARALLEL=4`, `OLLAMA_KEEP_ALIVE=1h`, `OLLAMA_FLASH_ATTENTION=true`; llama-server still started with `-c 8192 -np 1`, now `--flash-attn on` | `data/logs/ollama-serve-2.log` |
| Client settings | `num_ctx` 8192 (`NUM_CTX` in `packages/agent/src/ollama.ts`), `think: false` on every call, 180 s timeout per call | `scripts/benchmark-local.ts`, `packages/agent/src/ollama.ts` |
| Benchmark harness | `scripts/benchmark-local.ts`, mode `direct`: three workloads (world_draft with a 2048-token budget, edit_patch and validator_repair with 512), one recorded first run then N warm runs each, up to 2 schema-repair retries per run; "ms to valid" includes the retries | script source |
| Probe harness | `scripts/probe-model.ts`: world draft with schema, one real tool call (`read_world_state`), one patch draft; PROBE_RUNS runs | script source |
| GPU sharing | Ollama is shared with other owners' sessions: a rehearsal server plus agent (`apps/server`, `packages/agent --mode direct`), and `openclaw agent exec` smoke runs. With `-np 1` every foreign `/api/chat` call queues in front of or behind a benchmark call, so each run below is labelled with how many foreign calls overlapped it (matched by request duration in the daemon's GIN log) | `ps`, `data/logs/ollama-serve*.log` |

## 3. Models

| Tag | Architecture | Parameters | Quantization | Model-card context | Size on disk | Capabilities | Resident memory (8192 ctx) |
|---|---|---|---|---|---|---|---|
| qwen3.5:4b | qwen35 | 4.7B | Q4_K_M | 262144 | 3.4 GB (`ollama list`) | completion, vision, tools, thinking (off in Beetle) | 3.3 GB per `ollama ps` (100% GPU); llama-server process 4133 MiB per `nvidia-smi --query-compute-apps` |
| qwen3.8:27b | not observed | not observed | not observed | not observed | 16 GB main layer + 931 MB second layer per the pull log (17.7 GB in the brief); never present in `ollama list` as of 13:25 CDT | not observed | not measured |

`ollama show qwen3.8:27b` has not been run because the tag has never existed locally (section 6).

## 4. qwen3.5:4b measurements

All times are wall-clock milliseconds from the client, including Ollama queueing. "Valid" means the output parsed and
passed the Zod schema (plus, for validator_repair, contained an `add_bridge` touching `isle-temple`).

### 4.1 Cold versus warm

| Measurement | Value | GPU state | Source |
|---|---|---|---|
| True cold load (model file never loaded since daemon start) | load 23144 ms inside a 54415 ms first world draft (831 output tokens, eval 15448 ms) | quiet | `data/logs/probe-run.log` run 0, 11:56 CDT |
| Reload after eviction, file already in page cache | load 4151 ms inside a 55446 ms first world draft (2 attempts, 1 retry) | 2 foreign calls in the 2.5 min window | `bench-qwen3.5_4b-1791049348895.json` cold record |
| "Cold" record when the model was already resident | load 1 ms; the harness's "cold" run is then an ordinary warm run | - | 13:03 and 13:19 benchmark files |

The benchmark harness does not unload the model, so only the probe's 23.1 s is a true cold number. Budget 25 s for the
first draft after a daemon restart; after that the model stays resident for 30 min (first daemon) or 1 h (second).

### 4.2 Benchmark A: 12:42 CDT, 3 warm runs, first daemon, 2 foreign calls in the window

File `data/benchmarks/bench-qwen3.5_4b-1791049348895.json` (13 chat requests completed on the daemon in the window,
11 of them this benchmark's). Generation rate on the valid world drafts was 55.6 output tokens/s on every run, equal
to the probe's quiet-GPU rate (57.4 tok/s from `evalMs`), so these runs are treated as quiet.

| workload | runs | valid | ms total min/p50/max | ms to valid min/p50/max | output tok p50 | retries | failures |
|---|---|---|---|---|---|---|---|
| world_draft | 3 | 3/3 | 26234/26529/27746 | 26234/26529/27746 | 1476 | 0 | none |
| edit_patch | 3 | 3/3 | 2247/2321/2522 | 2247/2321/2522 | 119 | 0 | none |
| validator_repair | 3 | 3/3 | 1401/1538/1818 | 1401/1538/1818 | 83 | 0 | none |

First run (model reloaded): 55446 ms, load 4151 ms, valid after 1 retry.

### 4.3 Benchmark B: 12:51 to 13:03 CDT, 5 warm runs requested, first daemon, heavily contended, then daemon restart

File `data/benchmarks/bench-qwen3.5_4b-1791050596040.json`. 47 chat requests completed on the daemon between 12:51
and 13:03; 15 were this benchmark's, so about 32 foreign calls (rehearsal-agent briefs of 30 to 70 s each and openclaw
smoke runs) were interleaved. At 13:03:16 the daemon was restarted by another owner and the remaining 8 runs failed
with "Ollama unreachable". These numbers measure contention, not the model.

| workload | runs | valid | ms total min/p50/max | ms to valid min/p50/max | retries | failures |
|---|---|---|---|---|---|---|
| world_draft | 5 | 4/5 | 58848/119068/214053 | 58848/88588/124636 | 7 | 1 run: truncated JSON on all 3 attempts (2048-token budget hit each time) |
| edit_patch | 5 | 2/5 | 5455 and 45050 on the two that ran | 5455/5455/45050 | 0 | 3 runs: daemon unreachable |
| validator_repair | 5 | 0/5 | - | n/a | 0 | 5 runs: daemon unreachable |

First run (already resident, load 1 ms): 30851 ms, valid, 0 retries.

### 4.4 Benchmark C: 13:08 to 13:19 CDT, 5 warm runs, second daemon (flash attention on), gated start, 18 foreign calls in the window

File `data/benchmarks/bench-qwen3.5_4b-1791051548394.json`. The run waited 130 s for a quiet window (no chat call for
20 s, no openclaw exec alive) before starting at 13:07:57, but foreign calls resumed during it: 39 chat requests
completed in the 671 s window, 21 of them this benchmark's, 18 foreign. Per-run labels below come from matching each
single-attempt run to the daemon log by duration and counting overlapping foreign calls.

| workload | runs | valid | ms total min/p50/max | ms to valid min/p50/max | output tok p50 | retries | failures |
|---|---|---|---|---|---|---|---|
| world_draft | 5 | 4/5 | 23763/60406/97863 | 23763/28735/61391 | 1285 | 3 | 1 run: Zod, localPosition outside +/-20 on all 3 attempts |
| edit_patch | 5 | 5/5 | 2662/2718/3166 | 2662/2718/3166 | 122 | 0 | none |
| validator_repair | 5 | 5/5 | 1028/1037/1435 | 1028/1037/1435 | 45 | 0 | none |

World drafts one by one:

| run | ms total | attempts | valid | output tokens | tok/s | overlapping foreign calls | reading |
|---|---|---|---|---|---|---|---|
| first (resident) | 378593 | 3 | no (truncated JSON x3) | 6144 | 16.2 | not matched (multi-attempt) | contended; 16 tok/s is a third of the quiet rate |
| #1 | 60406 | 1 | yes | 1285 | 21.3 | not uniquely matched | contended by rate |
| #2 | 23763 | 1 | yes | 1090 | 45.9 | 0 | quiet |
| #3 | 61391 | 2 | yes | 2736 | 44.6 | not matched (multi-attempt) | one repair round; rate says quiet |
| #4 | 28735 | 1 | yes | 1281 | 44.6 | 2 (31 s and 32 s calls) | near quiet |
| #5 | 97863 | 3 | no (Zod x3) | 4306 | 44.0 | not matched (multi-attempt) | rate says quiet; the model, not the GPU, failed |

Note the quiet-GPU generation rate on the second daemon (44 to 46 tok/s) is below the first daemon's 55.6 tok/s. The
only configuration differences observed are flash attention (on versus auto) and the concurrent 27b download; the
cause was not isolated.

### 4.5 Probe (11:56 CDT, PROBE_RUNS=2, first daemon, quiet)

`data/logs/probe-run.log` and `data/logs/probe-qwen3.5_4b.json`.

| probe | run 0 | run 1 |
|---|---|---|
| world_draft | 54415 ms (load 23144 ms, eval 15448 ms, 831 tokens), valid, 5 islands 2 bridges | 19741 ms (load 1 ms, eval 19628 ms, 1127 tokens), valid, 5 islands 5 bridges |
| tool_call | 394 ms, called `read_world_state` with `{}` | 329 ms, called `read_world_state` with `{}` |
| patch_draft | 1568 ms, valid (set_hazard lava, add_bridge) | 2231 ms, invalid: bridge width 10 exceeds the schema maximum of 4 |

Tool calling works on the 4b: both probe runs produced a real `tool_calls` entry naming the tool the system prompt
asked for first, with no stray text.

### 4.6 Validity and retries across every 4b run recorded today

| workload | first-attempt valid | valid within 2 retries | notes |
|---|---|---|---|
| world_draft | 9/18 (50%) | 15/18 (83%) | probe 2/2 and 2/2; A 3/4 and 4/4; B 1/6 and 5/6; C 3/6 and 4/6. Failure modes: `localPosition` written in world coordinates (outside +/-20), and drafts that run to the 2048-token budget and truncate |
| edit_patch | 11/12 (92%) | 11/12 | probe 1/2 (bridge width 10); A 3/3; B 2/2 that reached the daemon; C 5/5 |
| validator_repair | 8/8 (100%) | 8/8 | A 3/3, C 5/5; every repair added the missing bridge to `isle-temple` |
| tool_call | 2/2 | - | probe only |

Retries in the live prompt run (docs/RESULTS.md, 12:43 to 12:47 CDT) agree with this: edits that parsed committed in
3.0 s; both briefs failed on `localPosition` after 3 attempts in 70 and 77 s.

## 5. Reading against the rule

| Task | qwen3.5:4b, quiet GPU, warm, time to a valid result | Against the ~10 s target |
|---|---|---|
| Brief to valid world draft, first attempt valid | 23.8 to 27.7 s (A: 26.2/26.5/27.7; C quiet runs: 23.8 and 28.7) | not met; 2.4x to 2.8x over |
| Brief to valid world draft, one repair round | 55.4 s (A first run), 61.4 s (C #3) | not met |
| Brief that never validates in 3 attempts | 97.9 s (C #5), 70 to 77 s in the live run | fails |
| Edit to valid patch | 2.2 to 3.2 s | met |
| Validator repair to valid patch | 1.0 to 1.8 s | met |
| Tool call | 0.33 to 0.39 s | met |
| Any of the above under foreign Ollama load | world drafts 58 to 214 s, an edit 45 s (B), 60 s (C #1) | not met; the GPU must be quiet during the demo |

## 6. qwen3.8:27b status: not benchmarked

| Time (CDT) | Event | Source |
|---|---|---|
| 11:44 | `ollama pull qwen3.8:27b` started by another owner, chained after the 4b pull (process start time from `ps` etime at 12:51) | `ps`, `data/logs/pull-qwen3.8-27b.log` |
| 12:51 | 52%, 8.8 GB of 16 GB, 3.6 MB/s, ETA 36 min | pull log |
| 13:02 | 74%, 12 GB of 16 GB; the 16 GB layer's partial file was last written at 13:02 | pull log, blob store mtime |
| 13:03:17 | Ollama daemon restarted by another owner (new log `ollama-serve-2.log`, flash attention on, keep-alive 1 h); the pull process was restarted against the new daemon | serve logs, `ps` |
| 13:06 to 13:16 | restarted pull resumed the main layer in 16 x 1 GB parts | `ollama-serve-2.log` download lines |
| 13:16 to 13:19 | "verifying sha256 digest" then `Error: digest mismatch, file must be downloaded again: want sha256:f5f1dd89..., got sha256:c0c59040...`; exit recorded as `PULL27B_DONE` | pull log |
| 13:19:12 | second pull started by another owner (`data/logs/pull-qwen3.8-27b-2.log`), downloading the main layer from 0 in 17 x 1 GB parts; 2% at 13:20 at 5.9 MB/s | serve-2 log, pull-2 log |

At 13:23 CDT the second pull reported 9% (1.5 GB of 16 GB) at 5.5 MB/s with its own ETA of 46 min, so the layer
completes at about 14:09 CDT at best, and the sha256 verification (which took about 3 min on the first attempt) runs
after that. The tag is therefore not expected before the 14:10 polling cutoff, and the 14:20 quiet-GPU cutoff for the
rehearsal leaves no window to benchmark it even if it does. The 27b is being
polled (`ollama list` every 60 s) until 14:10; if it appears, a reduced benchmark (BEETLE_BENCH_RUNS=2, true cold load
on the first call) runs immediately and its table is appended as section 9. Until then no 27b number exists, and none
is claimed.

## 7. Recommendation for the demo

Use qwen3.5:4b (Q4_K_M), already resident, for the 15:32 demo.

Reasons, all measured:

1. It is the only model with a measured time to a valid result. The 27b has not been pulled successfully (section 6),
   and even if it lands at 14:05 there is no quiet-GPU window before 14:20 long enough to measure cold load, three
   workloads and tool calling with any confidence.
2. Edits and repairs, which are most of the demo script, complete and validate in 1.0 to 3.2 s warm on a quiet GPU
   (sections 4.2, 4.4), with 19 of 20 first attempts valid.
3. World drafts complete and validate in 24 to 28 s warm when the first attempt is valid (about half the time) and in
   55 to 61 s with one repair round. The ~10 s warm target for a small world is not met by the 4b; it is 2.4x to 2.8x
   over on a quiet GPU. Present the brief step with a visible 30 s budget and keep one pre-drafted world as a fallback
   if a brief fails three attempts (observed in 3 of 18 drafts).
4. Cold load is 23.1 s on a never-loaded file; the first daemon's keep-alive was 30 min and the second's is 1 h, so
   send one warm-up request before the demo starts and do not let the model idle past the keep-alive.
5. Latency is dominated by GPU sharing, not the model: the same world draft took 24 s on a quiet GPU and 58 to 214 s
   while other owners' agents were calling Ollama. No other Ollama client (rehearsal agent, openclaw smoke runs, this
   benchmark) may run during the demo; all model calls from this track stop at 14:20 CDT.

What would change the decision: a 27b measurement showing a valid world draft in less time than the 4b's 24 to 28 s
first-attempt-valid figure, or a materially higher first-attempt validity rate that removes the 55 to 98 s repair
tail, on a quiet GPU, with tool calling confirmed. None of that has been observed.

## 8. Files

| File | Content |
|---|---|
| `data/benchmarks/bench-qwen3.5_4b-1791049348895.json` | benchmark A (12:42 CDT, 3 runs) |
| `data/benchmarks/bench-qwen3.5_4b-1791050596040.json` | benchmark B (13:03 CDT, 5 runs, contended, daemon restart mid-run) |
| `data/benchmarks/bench-qwen3.5_4b-1791051548394.json` | benchmark C (13:19 CDT, 5 runs, gated, 18 foreign calls) |
| `data/logs/probe-run.log`, `data/logs/probe-qwen3.5_4b.json` | probe (true cold load, tool call) |
| `data/logs/ollama-serve.log`, `data/logs/ollama-serve-2.log` | daemon request logs used for the contention labels |
| `data/logs/pull-qwen3.8-27b.log`, `data/logs/pull-qwen3.8-27b-2.log` | 27b pull attempts |
