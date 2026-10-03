// A tiny tile canvas used by samples and level generators.
export class Paint {
  w: number;
  h: number;
  cells: string[][];
  constructor(w: number, h: number, fill = ".") {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => Array(w).fill(fill));
  }
  static from(rows: string[]) {
    const p = new Paint(rows[0].length, rows.length);
    p.cells = rows.map((r) => [...r]);
    return p;
  }
  get(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.cells[y][x] : "#";
  }
  set(x: number, y: number, ch: string) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.cells[y][x] = ch;
    return this;
  }
  // Inclusive rectangle.
  rect(x0: number, y0: number, x1: number, y1: number, ch: string) {
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) this.cells[y][x] = ch;
    return this;
  }
  // Ground from column x0 to x1 with its top at row `top`.
  ground(x0: number, x1: number, top: number, ch = "#") {
    return this.rect(x0, top, x1, this.h - 1, ch);
  }
  border(ch = "W") {
    this.rect(0, 0, this.w - 1, 0, ch).rect(0, this.h - 1, this.w - 1, this.h - 1, ch);
    return this.rect(0, 0, 0, this.h - 1, ch).rect(this.w - 1, 0, this.w - 1, this.h - 1, ch);
  }
  rows() {
    return this.cells.map((r) => r.join(""));
  }
}
