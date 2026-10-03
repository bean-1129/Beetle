/** Inline beetle glyph plus the word BEETLE. No external assets. */
export function BeetleGlyph({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Beetle" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#f0b45a" strokeWidth="3" strokeLinecap="round">
        <path d="M22 10 L14 4" /><path d="M42 10 L50 4" />
        <path d="M12 30 L4 26" /><path d="M52 30 L60 26" />
        <path d="M13 42 L5 48" /><path d="M51 42 L59 48" />
      </g>
      <ellipse cx="32" cy="38" rx="19" ry="22" fill="#e9e3d3" />
      <circle cx="32" cy="14" r="8" fill="#cfc6b0" />
      <path d="M32 20 V60" stroke="#0e2a2f" strokeWidth="2.5" />
      <path d="M15 32 Q32 26 49 32" stroke="#0e2a2f" strokeWidth="2.5" fill="none" />
      <circle cx="24" cy="42" r="3" fill="#0e2a2f" /><circle cx="40" cy="42" r="3" fill="#0e2a2f" />
      <circle cx="26" cy="52" r="2.2" fill="#0e2a2f" /><circle cx="38" cy="52" r="2.2" fill="#0e2a2f" />
      <circle cx="29" cy="12" r="1.8" fill="#0e2a2f" /><circle cx="35" cy="12" r="1.8" fill="#0e2a2f" />
    </svg>
  );
}

export function Wordmark({ size = 34 }: { size?: number }) {
  return (
    <span className="wordmark">
      <BeetleGlyph size={size} />
      <span>BEETLE</span>
    </span>
  );
}

/** Same glyph as a plain string for non-React pages. */
export function wordmarkHtml(size = 34): string {
  return `<span class="wordmark"><svg width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Beetle" xmlns="http://www.w3.org/2000/svg">
<g fill="none" stroke="#f0b45a" stroke-width="3" stroke-linecap="round"><path d="M22 10 L14 4"/><path d="M42 10 L50 4"/><path d="M12 30 L4 26"/><path d="M52 30 L60 26"/><path d="M13 42 L5 48"/><path d="M51 42 L59 48"/></g>
<ellipse cx="32" cy="38" rx="19" ry="22" fill="#e9e3d3"/><circle cx="32" cy="14" r="8" fill="#cfc6b0"/>
<path d="M32 20 V60" stroke="#0e2a2f" stroke-width="2.5"/><path d="M15 32 Q32 26 49 32" stroke="#0e2a2f" stroke-width="2.5" fill="none"/>
<circle cx="24" cy="42" r="3" fill="#0e2a2f"/><circle cx="40" cy="42" r="3" fill="#0e2a2f"/><circle cx="26" cy="52" r="2.2" fill="#0e2a2f"/><circle cx="38" cy="52" r="2.2" fill="#0e2a2f"/>
<circle cx="29" cy="12" r="1.8" fill="#0e2a2f"/><circle cx="35" cy="12" r="1.8" fill="#0e2a2f"/></svg><span>BEETLE</span></span>`;
}
