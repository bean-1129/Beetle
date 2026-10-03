// Builds a game off the main thread: levels, validation and playtesting take a few seconds.
import { specFromDesign } from "./build.ts";
import type { DesignDoc } from "./design.ts";

type Req = { id: number; design: DesignDoc; seed: number };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, design, seed } = e.data;
  try {
    const r = specFromDesign(design, { seed, onProgress: (message) => (self as unknown as Worker).postMessage({ id, progress: message }) });
    (self as unknown as Worker).postMessage({ id, result: r });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
