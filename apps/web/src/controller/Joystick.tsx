import { useCallback, useEffect, useRef } from 'react';

type Props = {
  radius?: number;
  deadZone?: number;
  onChange: (x: number, z: number) => void;
  onRelease: () => void;
  /** Bumps to force a visual reset (for example when the socket drops). */
  resetKey?: number;
};

/**
 * Thumb joystick. Pointer events with capture. Screen up is +Z (north), screen right is +X (east).
 * Output axes are normalised to [-1, 1] with a radial dead zone.
 */
export function Joystick({ radius = 60, deadZone = 0.08, onChange, onRelease, resetKey = 0 }: Props) {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const activeId = useRef<number | null>(null);
  const centre = useRef({ x: 0, y: 0 });
  const last = useRef({ x: 0, z: 0 });

  const setKnob = (dx: number, dy: number) => {
    const knob = knobRef.current;
    if (knob) knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const emit = useCallback((x: number, z: number) => {
    if (Math.abs(x - last.current.x) < 0.005 && Math.abs(z - last.current.z) < 0.005) return;
    last.current = { x, z };
    onChange(x, z);
  }, [onChange]);

  const release = useCallback(() => {
    activeId.current = null;
    setKnob(0, 0);
    last.current = { x: 0, z: 0 };
    onRelease();
  }, [onRelease]);

  useEffect(() => { release(); }, [resetKey, release]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeId.current !== null) return;
    const base = baseRef.current;
    if (!base) return;
    e.preventDefault();
    activeId.current = e.pointerId;
    try { base.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    const r = base.getBoundingClientRect();
    centre.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    move(e.clientX, e.clientY);
  };

  const move = (cx: number, cy: number) => {
    let dx = cx - centre.current.x;
    let dy = cy - centre.current.y;
    const mag = Math.hypot(dx, dy);
    if (mag > radius) { dx = (dx / mag) * radius; dy = (dy / mag) * radius; }
    setKnob(dx, dy);
    let nx = dx / radius;
    let nz = -dy / radius;
    const m = Math.hypot(nx, nz);
    if (m < deadZone) { emit(0, 0); return; }
    const scaled = Math.min(1, (m - deadZone) / (1 - deadZone));
    nx = (nx / m) * scaled;
    nz = (nz / m) * scaled;
    emit(round3(nx), round3(nz));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activeId.current) return;
    e.preventDefault();
    move(e.clientX, e.clientY);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activeId.current) return;
    e.preventDefault();
    try { baseRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    release();
  };

  const size = radius * 2 + 44;
  return (
    <div
      ref={baseRef}
      className="joystick"
      role="application"
      aria-label="Move. Drag the thumb pad."
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
    >
      <div className="joystick-ring" aria-hidden="true" />
      <div ref={knobRef} className="joystick-knob" aria-hidden="true" />
    </div>
  );
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
