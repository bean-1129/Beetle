// Export: one HTML file with the player, the spec and all art inlined. A strict content
// security policy means the exported game cannot reach the network at all.
import type { GameSpec } from "../spec/types.ts";
import { scriptWrapper } from "../runtime/script.ts";

export const EXPORT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// JSON inside a script tag must not be able to close it.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").split(LS).join("\\u2028").split(PS).join("\\u2029");
const safeScript = (code: string) => code.replace(/<\/script/gi, "<\\/script");

export function exportHtml(spec: GameSpec, runtimeJs: string): string {
  const bg = spec.meta.palette[0] || "#101418";
  const html = page(spec, runtimeJs, bg, 0);
  if (!spec.script) return html;
  // Report script errors with the line number inside the game's own code.
  const line = html.split("\n").findIndex((l) => l.startsWith("<script>globalThis.__studio2dScript")) + 2;
  return page(spec, runtimeJs, bg, line);
}

function page(spec: GameSpec, runtimeJs: string, bg: string, scriptLine: number): string {
  const catcher = spec.script
    ? `<script>globalThis.__studio2dScriptLine=${scriptLine};globalThis.__studio2dErrors=[];addEventListener("error",function(e){globalThis.__studio2dErrors.push(e.message+(e.lineno?" (line "+(e.lineno-${scriptLine})+")":""));});</script>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<meta name="generator" content="Beetle 2D">
<title>${esc(spec.meta.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: ${bg}; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { width: 100vw; height: 100vh; display: block; outline: none; image-rendering: pixelated; touch-action: none; }
</style>
</head>
<body>
<canvas id="studio2d-canvas" tabindex="0" aria-label="${esc(spec.meta.title)}, a game made with Beetle 2D"></canvas>
<script type="application/json" id="studio2d-spec">${safeJson(spec)}</script>
${catcher}${spec.script ? `<script>${safeScript(scriptWrapper(spec.script.code))}</script>\n` : ""}<script>${safeScript(runtimeJs)}</script>
</body>
</html>
`;
}

// A Studio2D project folder: the spec as editable JSON, the playable file and a short readme.
export function projectFiles(spec: GameSpec, runtimeJs: string): Record<string, string> {
  const slug = spec.meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
  return {
    "game.json": JSON.stringify(spec, null, 2),
    [`${slug}.html`]: exportHtml(spec, runtimeJs),
    "README.txt": `${spec.meta.title}\n\n${spec.meta.pitch}\n\nOpen ${slug}.html in any browser to play. It works offline.\nOpen game.json in Beetle 2D to keep editing.\n\nMade with Beetle 2D. Genre: ${spec.meta.genre}. Levels: ${spec.levels.length}.\n`,
  };
}

export function fileName(spec: GameSpec) {
  return `${spec.meta.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 60) || "Studio2D game"}.html`;
}
