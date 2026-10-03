// Shelf packing of many small images into one sprite sheet.
import { pixels, blit, type Pixels } from "./pixels.ts";

export type Sheet = { image: Pixels; rects: Record<string, [number, number, number, number]> };

export function packSheet(items: { key: string; img: Pixels }[], maxWidth = 1024, pad = 1): Sheet {
  const sorted = items.slice().sort((a, b) => b.img.h - a.img.h || b.img.w - a.img.w);
  const rects: Sheet["rects"] = {};
  let x = pad, y = pad, shelf = 0, width = 0;
  for (const it of sorted) {
    if (x + it.img.w + pad > maxWidth) {
      x = pad;
      y += shelf + pad;
      shelf = 0;
    }
    rects[it.key] = [x, y, it.img.w, it.img.h];
    x += it.img.w + pad;
    width = Math.max(width, x);
    shelf = Math.max(shelf, it.img.h);
  }
  const image = pixels(Math.max(1, width), Math.max(1, y + shelf + pad));
  for (const it of items) {
    const [rx, ry] = rects[it.key];
    blit(image, it.img, rx, ry);
  }
  return { image, rects };
}
