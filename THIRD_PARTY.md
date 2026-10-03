# Third-party inventory

Beetle did not train any model weights and did not author the libraries below. Everything here is a dependency, a runtime, or a model served locally.

| Component | Version | License | Role |
|---|---|---|---|
| Node.js | 24.21.0 | MIT | runtime (project-local under .tools/) |
| OpenClaw | 2026.9.8 | see package | agent runtime; Beetle registers its own tool plugin |
| Ollama | 0.35.1 | MIT | local model server, loopback only |
| Qwen3.5 4B (`qwen3.5:4b`) | Ollama library tag | Apache-2.0 (per model card) | first available local model; benchmarked |
| Qwen3.8 27B (`qwen3.8:27b`) | Ollama library tag | see model card | first candidate; benchmarked only if the pull finishes in time |
| Fastify | ^5 | MIT | HTTP server |
| ws | ^8.18 | MIT | WebSocket server |
| zod | ^3.23 | MIT | runtime schema validation |
| React, react-dom | ^19 | MIT | director and controller UI |
| Vite, @vitejs/plugin-react | ^6 / ^4 | MIT | web build |
| Babylon.js (@babylonjs/core) | ^8 | Apache-2.0 | 3D rendering |
| qrcode | ^1.5 | MIT | join QR generation |
| Vitest | ^3 | MIT | tests |
| TypeScript, tsx | ^5.6 / ^4.19 | Apache-2.0 / MIT | language and runner |

Assets: all geometry is procedural. No fonts, textures, audio or models are fetched at runtime. Any file added under assets/ must be listed here with its license.
