# Third-party inventory

Beetle trained no model weights and authored none of the third-party components below. Everything here is a dependency, a runtime, or a model served locally. Versions and licenses were read on 2026-10-03 from the installed copies (`node_modules/<pkg>/package.json` `license` field, `--version` output, `ollama show`), not from the semver ranges in package.json. Pinned ranges are in the workspace package.json files.

## Runtimes

| Component | Version | License | Role |
|---|---|---|---|
| Node.js | v24.21.0 (`.tools/node/bin/node --version`) | MIT | runtime (project-local under .tools/) |
| OpenClaw | 2026.9.8 (fc23bc8) (`.tools/npm-global/bin/openclaw --version`) | MIT (`.tools/npm-global/lib/node_modules/openclaw/package.json`, LICENSE file present) | agent runtime; Beetle registers its own tool plugin |
| Ollama | 0.35.1 (`.tools/ollama/bin/ollama --version`) | MIT per upstream repository; the installed tarball also carries it in `.tools/ollama/lib/ollama/GO_LICENSE` (entry `github.com/ollama/ollama/LICENSE`, MIT). The same directory bundles llama.cpp/ggml (MIT), cpp-httplib (MIT) and Go dependency licenses. | local model server, loopback only |

## Models (served by Ollama)

| Component | Version | License | Role |
|---|---|---|---|
| Qwen3.5 4B (`qwen3.5:4b`) | Ollama library tag, id 2a654d98e6fb, 4.7B params, Q4_K_M (`ollama list` / `ollama show qwen3.5:4b`) | Apache-2.0 (`ollama show qwen3.5:4b` prints "Apache License Version 2.0, January 2004") | first available local model; benchmarked |
| Qwen3.8 27B (`qwen3.8:27b`) | Ollama library tag; not present in `ollama list` at time of writing | license per the Ollama library page and the Qwen model card; not verified locally | first candidate; benchmarked only if the pull finishes in time |

## npm dependencies (direct only)

Workspace-internal packages (`@beetle/contracts`, `@beetle/world`, `@beetle/observability`, `@beetle/agent`) are Beetle's own code and are not listed. `packages/observability` has no dependencies.

| Component | Version | License | Role |
|---|---|---|---|
| @types/node | 24.19.1 | MIT | root devDependency; Node type definitions |
| @types/ws | 8.18.2 | MIT | root devDependency; ws type definitions |
| tsx | 4.23.15 | MIT | root devDependency; TypeScript runner for server/agent/scripts |
| typescript | 5.9.3 | Apache-2.0 | root devDependency; language and typecheck |
| vitest | 3.2.7 | MIT | root devDependency; tests |
| fastify | 5.12.5 | MIT | apps/server; HTTP server |
| @fastify/static | 8.3.0 | MIT | apps/server; serves the built web app |
| ws | 8.22.0 | MIT | apps/server; WebSocket server |
| zod | 3.25.76 | MIT | apps/server, packages/agent, packages/contracts; runtime schema validation |
| @babylonjs/core | 8.56.2 | Apache-2.0 | apps/web; 3D rendering |
| qrcode | 1.5.4 | MIT | apps/web; join QR generation |
| react | 19.3.0 | MIT | apps/web; director and controller UI |
| react-dom | 19.3.0 | MIT | apps/web; DOM renderer |
| @types/qrcode | 1.5.6 | MIT | apps/web devDependency |
| @types/react | 19.3.0 | MIT | apps/web devDependency |
| @types/react-dom | 19.3.0 | MIT | apps/web devDependency |
| @vitejs/plugin-react | 4.7.0 | MIT | apps/web devDependency; React plugin for Vite |
| vite | 6.4.3 (`apps/web/node_modules/vite`) | MIT | apps/web devDependency; web build. A hoisted `node_modules/vite` 7.3.6 (MIT) also exists as a transitive dependency of vitest; apps/web resolves its own 6.4.3 copy. |

## OpenClaw plugin (`packages/agent/openclaw-plugin`)

The plugin has its own `package.json`. It declares no `dependencies` or `devDependencies`, only a peer dependency, and its `build.mjs` bundles one library and uses one build tool resolved from outside the package:

| Component | Version | License | Role |
|---|---|---|---|
| openclaw (peerDependency `>=2026.5.17`) | 2026.9.8 installed (see Runtimes) | MIT | host SDK; `openclaw/*` imports stay external to the bundle and are supplied by the host at load time |
| typebox | 1.3.34 (`.tools/npm-global/lib/node_modules/openclaw/node_modules/typebox`) | MIT | tool schema types; bundled into `dist/index.js` by `build.mjs`, resolved from the installed OpenClaw's node_modules |
| esbuild | 0.28.2 (root `node_modules/esbuild`, transitive via vite/vitest) | MIT | bundler invoked by `build.mjs`; build-time only, not shipped |

Note: the plugin package.json description says zod is also bundled, but `src/index.ts` does not import zod; the only bundled third-party library is typebox.

## Assets

Beetle authored no third-party assets. All 3D geometry is procedural (built in code with Babylon.js); no external fonts, textures, audio or model files are bundled or fetched at runtime, and `assets/` is empty. Any file added under `assets/` must be listed here with its license.
