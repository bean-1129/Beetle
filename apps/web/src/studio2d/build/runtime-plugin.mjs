// Bundles the Beetle 2D player (runtime/entry.ts) into one self-contained script for
// exported games and for the sandboxed play frame.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const RUNTIME_ENTRY = fileURLToPath(new URL("../runtime/entry.ts", import.meta.url));

async function bundle({ minify = true } = {}) {
  const out = await build({
    entryPoints: [RUNTIME_ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify,
    metafile: true,
    logLevel: "silent",
    legalComments: "none",
  });
  const inputs = Object.keys(out.metafile?.inputs ?? {}).map((f) => path.resolve(f));
  return { code: out.outputFiles[0].text, inputs };
}

/** The bundled player as one script's text. */
export async function bundleRuntime({ minify = true } = {}) {
  return (await bundle({ minify })).code;
}

// Vite plugin: `import runtime from "virtual:studio2d-runtime"` gives the bundled script text.
export function studio2dRuntimePlugin() {
  const id = "virtual:studio2d-runtime";
  const resolved = "\0" + id;
  let watched = new Set();
  return {
    name: "studio2d-runtime",
    resolveId(source) {
      return source === id ? resolved : null;
    },
    async load(source) {
      if (source !== resolved) return null;
      const { code, inputs } = await bundle();
      watched = new Set(inputs);
      for (const f of inputs) this.addWatchFile(f);
      return `export default ${JSON.stringify(code)};`;
    },
    // In dev, rebuild the bundled runtime when any of its sources change.
    handleHotUpdate(ctx) {
      if (!watched.has(path.resolve(ctx.file))) return;
      const mod = ctx.server.moduleGraph.getModuleById(resolved);
      if (mod) ctx.server.moduleGraph.invalidateModule(mod);
    },
  };
}
