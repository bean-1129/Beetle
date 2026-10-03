import { beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { exportHtml, projectFiles, EXPORT_CSP } from "../../apps/web/src/studio2d/export/export.ts";
import { samplePlatformer } from "../../apps/web/src/studio2d/samples/index.ts";
import { bundleRuntime } from "../../apps/web/src/studio2d/build/runtime-plugin.mjs";

let runtime = "";
beforeAll(async () => {
  runtime = await bundleRuntime();
}, 60000);

test("the runtime bundle contains no network code", () => {
  assert.ok(runtime.length > 20000);
  for (const api of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "importScripts", "RTCPeerConnection"])
    assert.ok(!runtime.includes(api), `bundle mentions ${api}`);
});

test("export is one self-contained HTML file with a no-network policy", () => {
  const spec = samplePlatformer();
  spec.meta.title = "Fox </script><b>";
  const html = exportHtml(spec, runtime);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(EXPORT_CSP));
  assert.ok(html.includes("default-src 'none'"));
  assert.equal((html.match(/<\/script>/g) || []).length, 2, "embedded JSON cannot close its script tag");
  assert.ok(!/src="http|href="http/.test(html));
  const files = projectFiles(spec, runtime);
  assert.ok(files["game.json"] && files["README.txt"]);
  assert.equal(Object.keys(files).filter((f) => f.endsWith(".html")).length, 1);
});

// The browser cases need Playwright with Chromium, which is not installed here.
test.skip("exported games run offline in a browser, make zero requests and replay deterministically (needs Playwright Chromium)", () => {});
test.skip("the engine holds 60 fps with a few hundred entities (needs Playwright Chromium)", () => {});
test.skip("menus work with the mouse and the keyboard (lose screen: retry and quit) (needs Playwright Chromium)", () => {});
test.skip("scripted games play in the page, and broken scripts report the line (needs Playwright Chromium)", () => {});
