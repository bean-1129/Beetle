import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export type GlyphKind = 'cross' | 'circle' | 'triangle' | 'square';

/** PlayStation style face glyphs, drawn inline so they take the button's text colour. */
export function Glyph({ kind }: { kind: GlyphKind }) {
  return (
    <svg className={`glyph glyph-${kind}`} viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'cross' && (<><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>)}
      {kind === 'circle' && <circle cx="12" cy="12" r="7.5" />}
      {kind === 'triangle' && <polygon points="12,4.5 20,18.5 4,18.5" />}
      {kind === 'square' && <rect x="5" y="5" width="14" height="14" rx="1.5" />}
    </svg>
  );
}

type PadButtonProps = {
  className?: string;
  label: string;
  ariaLabel?: string;
  active?: boolean;
  style?: CSSProperties;
  /** Bumps to forget a stuck pointer (socket drop, blur, hidden). */
  resetKey?: number;
  onPress: () => void;
  onRelease: () => void;
  children?: ReactNode;
};

/** Pointer-captured press/release button. Fires onPress once per pointer down and onRelease once per end. */
export function PadButton({ className = '', label, ariaLabel, active = false, style, resetKey = 0, onPress, onRelease, children }: PadButtonProps) {
  const down = useRef(false);
  useEffect(() => { down.current = false; }, [resetKey]);
  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (down.current) return;
    down.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    onPress();
  };
  const end = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!down.current) return;
    down.current = false;
    onRelease();
  };
  return (
    <button
      type="button"
      className={`pad-btn ${className} ${active ? 'active' : ''}`}
      style={style}
      onPointerDown={start}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
    >
      {children}
      <span className="pad-btn-label">{label}</span>
    </button>
  );
}

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: { dir: Dir; label: string; dx: number; dz: number }[] = [
  { dir: 'up', label: 'Up', dx: 0, dz: 1 },
  { dir: 'left', label: 'Left', dx: -1, dz: 0 },
  { dir: 'right', label: 'Right', dx: 1, dz: 0 },
  { dir: 'down', label: 'Down', dx: 0, dz: -1 },
];

/** Digital D-pad driving the same axes as the stick. Diagonals come from holding two directions. */
export function DPad({ onChange, onPress, resetKey = 0 }: { onChange: (x: number, z: number) => void; onPress?: () => void; resetKey?: number }) {
  const [pressed, setPressed] = useState<Set<Dir>>(() => new Set());
  const emit = useCallback((set: Set<Dir>) => {
    let x = 0; let z = 0;
    for (const d of DIRS) if (set.has(d.dir)) { x += d.dx; z += d.dz; }
    const m = Math.hypot(x, z);
    onChange(m > 1 ? x / m : x, m > 1 ? z / m : z);
  }, [onChange]);
  useEffect(() => { setPressed(new Set()); }, [resetKey]);
  const set = (dir: Dir, on: boolean) => {
    setPressed((prev) => {
      if (prev.has(dir) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(dir); else next.delete(dir);
      emit(next);
      return next;
    });
    if (on) onPress?.();
  };
  return (
    <div className="dpad" role="group" aria-label="Direction pad">
      {DIRS.map((d) => (
        <PadButton key={d.dir} className={`dpad-${d.dir}`} label="" ariaLabel={`Move ${d.label.toLowerCase()}`} active={pressed.has(d.dir)} resetKey={resetKey} onPress={() => set(d.dir, true)} onRelease={() => set(d.dir, false)}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><polygon points="12,5 19,15 5,15" /></svg>
        </PadButton>
      ))}
      <span className="dpad-hub" aria-hidden="true" />
    </div>
  );
}

export function Toggle({ label, hint, on, onChange, disabled = false }: { label: string; hint?: string; on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`sheet-toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={onChange} disabled={disabled}>
      <span className="sheet-toggle-text">
        <span className="sheet-toggle-label">{label}</span>
        {hint && <span className="sheet-toggle-hint">{hint}</span>}
      </span>
      <span className="sheet-toggle-knob" aria-hidden="true" />
    </button>
  );
}
