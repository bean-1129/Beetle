# Controller latency (measured)

Measured on 2026-10-03T17:59:39.652Z by `scripts/measure-latency.ts` (run: `npx tsx scripts/measure-latency.ts`).
Raw samples: `data/latency/latency-1791050379652.json`.

**Read the labels carefully.** "WebSocket RTT" and "input to server tick" are transport and simulation
latencies on loopback. They are **not** input-to-photon latency: no phone, no browser input sampling, no
Wi-Fi hop, no renderer, no GPU frame time and no display refresh is included. The number a player feels is
larger than anything in these tables.

## Results

| Measurement | n | min ms | p50 ms | p95 ms | max ms | mean ms |
|---|---:|---:|---:|---:|---:|---:|
| WebSocket RTT (ping/pong), both controllers | 400 | 0.11 | 0.48 | 0.81 | 6.32 | 0.51 |
| WebSocket RTT, Amber | 200 | 0.16 | 0.49 | 0.82 | 3.14 | 0.54 |
| WebSocket RTT, Azure | 200 | 0.11 | 0.45 | 0.75 | 6.32 | 0.49 |
| Input to server tick, idle, both controllers | 200 | 0.61 | 18.79 | 33.08 | 54.98 | 18.59 |
| Input to server tick, Amber idle | 100 | 0.66 | 18.05 | 32.93 | 54.98 | 18.12 |
| Input to server tick, Azure idle | 100 | 0.61 | 18.90 | 33.08 | 52.68 | 19.07 |
| Input to server tick, load (2 x 30 inputs/s), both controllers | 200 | 0.47 | 17.53 | 31.91 | 61.54 | 18.00 |
| Input to server tick, Amber load | 100 | 0.47 | 17.77 | 31.85 | 33.78 | 18.10 |
| Input to server tick, Azure load | 100 | 0.49 | 17.09 | 31.91 | 61.54 | 17.90 |
| Tick interval, client arrival (nominal 33.33) | 299 | 0.07 | 33.37 | 34.71 | 66.57 | 33.25 |
| Tick interval deviation from 33.33 ms, client arrival | 299 | 0.00 | 0.21 | 1.92 | 33.27 | 1.34 |
| Tick interval, server serverMs stamps (wall clock) | 299 | 0.00 | 33.00 | 34.00 | 66.00 | 33.25 |

Percentiles use nearest-rank over the raw samples. Tick jitter rows are over 299 intervals from 300 consecutive ticks (ticks 79 to 378, 0 gaps in tick numbering). 4 interval(s) were late (> 50 ms) and 4 were catch-up ticks (< 16.7 ms, sent back to back after a late one). The same outliers appear in the server's own `serverMs` stamps, so they come from the server's drift-corrected `setInterval` firing late on a loaded host, not from the socket. Tick numbering stays contiguous; the min/max of the interval rows describe server timer scheduling, not transport jitter. The load run streamed 806 and 806 inputs (30.1 and 30.1 Hz effective per controller) over 26.8 s.
Ticks elapsed between sending the input and the first moving tick (idle): Amber idle min 1, p50 1, max 1; Azure idle min 1, p50 1, max 2. Under load: Amber load min 1, p50 1, max 1; Azure load min 1, p50 1, max 2.
No sample failures. No server error messages were received.

## Method

- Server: the real Beetle server (`apps/server/src/main.ts`) started as a child process (pid 172450, own event loop) on 127.0.0.1:7782 with `BEETLE_START_WORLD=fixture` (garden5) and a scratch `BEETLE_DATA_DIR` that is deleted afterwards. Fixed 30 Hz simulation (33.33 ms per tick), player speed 4.5 m/s, input timeout 600 ms, input rate limit 60/s.
- Controllers: two players joined exactly like phones do: `POST /api/director/invite` (director token) then `POST /api/join` with the invite code, then a WebSocket to `/ws` (the `ws` package, Origin set to the server URL) and a `hello` with role `controller`.
- Clock: every client-side timestamp is `performance.now()` in the measuring process (one monotonic clock); arrival times are taken inside the socket's `message` handler before parsing. The server's `serverMs` (wall clock) is used only for the secondary "server serverMs stamps" row.
- (a) WebSocket RTT: `{type:'ping', t}` and the matching `pong`; RTT = pong arrival - t. 200 sequential samples per controller with a 2-10 ms random gap, while ticks keep flowing.
- (b) Input to server tick: from rest, send `input` with axes x=+1 at t0; latency = arrival time of the first `tick` whose player x is greater than before, minus t0. Then send x=-1 until x is back at the home position, send zero axes, and wait for three consecutive ticks with zero velocity and unchanged position before the next sample (plus a 40-120 ms random rest so t0 lands uniformly across the tick phase). 100 samples per controller, one controller at a time, no other traffic.
- (c) Tick interval jitter: arrival-time differences of 300 consecutive `tick` messages on one idle controller socket; also the absolute deviation from the nominal 33.33 ms.
- (d) Load: both controllers run a 30 inputs/s stream (setInterval) that repeats the current command, and both run the (b) procedure at the same time, 100 samples each.

## Machine

- Host: promaxgb10-5ca9, Linux 7.0.0-1019-nvidia (arm64)
- CPU: Cortex-X925 + Cortex-A725 x 20; RAM 121.6 GiB; 1-minute load average at the end of the run: 12.6
- Node v24.21.0; transport: WebSocket over TCP loopback 127.0.0.1:7782
- Run duration 93.4 s

## Limits of what was measured

- Loopback only. A real controller is a phone on Wi-Fi: add the wireless RTT (typically several ms to tens of ms, with its own tail) on top of every row.
- No browser: the `/controller` page's touch sampling, JavaScript timers and the browser's WebSocket stack are not in the numbers. Neither is the display's render loop: "input to server tick" ends when the tick JSON reaches the measuring process, not when a pixel changes.
- The input-to-tick figure is quantised by the 30 Hz loop: an input that arrives just after a tick boundary waits up to one full tick before it moves the player, so the spread between min and max is dominated by tick phase, not by transport.
- The measuring client and the server ran on the same machine; CPU contention from other processes (load average above) affects both. The load scenario is two scripted controllers at 30 inputs/s, not a crowd and not the agent, Ollama or a display client.
- One run on one machine. Repeat the script for distribution over time; this file is overwritten by each run and the JSON files accumulate under `data/latency/`.
