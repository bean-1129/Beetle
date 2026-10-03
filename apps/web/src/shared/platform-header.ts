// Shared platform header markup: Beetle wordmark plus the 2D / 3D switch, identical on every page.
// The token is carried in links when one is stored for this session.
import { takeDirectorToken } from './token.ts';

export type PlatformSide = '2d' | '3d';

export function platformLinks(): { href2d: string; href3d: string } {
  let token: string | null = null;
  try { token = takeDirectorToken(); } catch { token = null; }
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return { href2d: `/2d${q}`, href3d: `/director${q}` };
}

/** Plain DOM version for non-React pages (landing, play). */
export function renderPlatformHeader(host: HTMLElement, side: PlatformSide, extra?: HTMLElement): void {
  const { href2d, href3d } = platformLinks();
  host.classList.add('bp-top');
  host.innerHTML = '';
  const brand = document.createElement('a');
  brand.className = 'bp-brand'; brand.href = '/'; brand.textContent = 'BEETLE';
  const sw = document.createElement('nav');
  sw.className = 'bp-switch'; sw.setAttribute('aria-label', 'Choose 2D or 3D');
  for (const [label, href, key] of [['2D games', href2d, '2d'], ['3D worlds', href3d, '3d']] as const) {
    const a = document.createElement('a');
    a.href = href; a.textContent = label;
    if (key === side) a.setAttribute('aria-current', 'page');
    sw.appendChild(a);
  }
  const spacer = document.createElement('div'); spacer.className = 'bp-spacer';
  host.append(brand, sw, spacer);
  if (extra) host.appendChild(extra);
}
