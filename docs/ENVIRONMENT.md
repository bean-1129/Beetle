# Beetle environment report

Observed on the assigned machine on 2026-10-03. Non-secret values only.

## Time

| Item | Observed |
|---|---|
| Machine clock | 11:43 CDT (America/Chicago), 16:43 UTC |
| Boston equivalent | 12:43 EDT |
| Code deadline (rules, Boston) | 18:00 EDT = 17:00 CDT |
| Remaining at inspection | about 5h15m |
| Integration reserve begins | 15:30 CDT (final 90 minutes) |

The machine timezone is America/Chicago, not America/New_York. All deadline math above uses the rules' Boston times converted to the machine clock.

## Hardware

| Item | Observed |
|---|---|
| Architecture | aarch64 (Arm64) |
| Kernel | 7.0.0-1019-nvidia |
| CPU threads | 20 |
| Unified memory | 121 GiB total, 113 GiB available at inspection |
| Disk | 3.6 TB NVMe, 45 GB used, 3.4 TB free |
| GPU | NVIDIA GB10, driver 580.178.04. nvidia-smi reports memory as N/A (unified memory). Ollama registers it as CUDA0, compute 12.1, 121.6 GiB total, via its cuda_v13 bundle. The cuda_v12 bundle is skipped as unsupported; that log line is benign. |

## Runtimes (project-local, under .tools/, not system-wide)

| Tool | Version | Location |
|---|---|---|
| Node | 24.21.0 | .tools/node/bin |
| npm | 11.19.0 | .tools/node/bin |
| OpenClaw | 2026.9.8 (fc23bc8) | .tools/npm-global/bin/openclaw |
| Ollama | 0.35.1 | .tools/ollama/bin/ollama, server bound to 127.0.0.1:11434; restarted at 13:43 CDT with OLLAMA_NUM_PARALLEL=1 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KEEP_ALIVE=1h after the daemon stopped answering chat requests; this model architecture ignores parallel slots (daemon log) |
| Python | system python3 | used only for scripts, not product inference |

Note: the earlier setup ran `npm config set prefix .tools/npm-global --location=user`, which changed the user npmrc prefix for global installs. OpenClaw's install scripts (esbuild, koffi, protobufjs, openclaw postinstall) were blocked by npm allow-scripts; see BUILD_STATUS.md for whether that needed a rerun.

## Models

| Tag | Size | Status at inspection |
|---|---|---|
| qwen3.5:4b | 3.39 GB | pulling, 78 percent, ~5 MB/s |
| qwen3.8:27b | 17.74 GB | not present: the first pull ended in a digest mismatch after a daemon restart, the second was stopped at 41 percent when the daemon had to be restarted again; never benchmarked (docs/MODEL_SELECTION.md) |

Quantization and exact digest are recorded by `scripts/benchmark-local.mjs` output once a model is present (`ollama show`). No cloud model is configured anywhere in the product path. Qwen3.8-2.4T-A95B is explicitly not downloaded.

## Network

| Item | Observed |
|---|---|
| LAN interface | wlP9s9 (Wi-Fi). Observed 172.20.65.84/20 at 11:43 CDT, then 192.168.204.116/20 from about 12:40 CDT (network changed); the server auto-detects the current address at startup |
| docker0 | 172.17.0.1/16 (unrelated, untouched) |
| Download bandwidth | about 5 to 7 MB/s, with stalls; the first workspace npm install died with read ETIMEDOUT |

## Ports

| Port | Use |
|---|---|
| 127.0.0.1:11434 | Ollama (loopback only) |
| 127.0.0.1:11000 | pre-existing unrelated loopback service, not touched |
| 0.0.0.0:7700 | Beetle server: HTTP, WebSocket, static web build (team LAN) |
| 127.0.0.1:5173 | Vite dev server (development only) |
| 127.0.0.1 | OpenClaw gateway, loopback only (port recorded in docs/ARCHITECTURE.md once configured) |
| 22, 631, 53 | pre-existing system services, untouched |

## Blockers and limitations

- Network: flaky Wi-Fi; dependency installs and model pulls need retries.
- Team chat channel: no credentials available; report publishing stays local (file plus UI).
- Physical phones: require a person on site; marked unrun until done.
- Playwright browsers: not downloaded (large download on a slow link); browser tests are deferred unless time permits.
