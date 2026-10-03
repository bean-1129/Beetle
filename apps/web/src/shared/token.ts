const KEY = 'beetle.directorToken';

function store(token: string): void {
  try { sessionStorage.setItem(KEY, token); } catch { /* ignore */ }
  try { localStorage.setItem(KEY, token); } catch { /* ignore */ }
}

/** Director token from ?token= (stored, stripped from the URL), from this tab, or from a previous visit on this browser. */
export function takeDirectorToken(): string | null {
  let token: string | null = null;
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl && fromUrl.length >= 8) {
      token = fromUrl;
      store(fromUrl);
      url.searchParams.delete('token');
      history.replaceState(history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  } catch { /* ignore */ }
  if (!token) {
    try { token = sessionStorage.getItem(KEY); } catch { token = null; }
  }
  if (!token) {
    try { token = localStorage.getItem(KEY); } catch { token = null; }
    if (token) { try { sessionStorage.setItem(KEY, token); } catch { /* ignore */ } }
  }
  if (!token) token = bootstrapSync();
  return token && token.length >= 8 ? token : null;
}

let bootstrapTried = false;
/** One synchronous same-origin request per page load, so callers that read the token at startup work on this machine. */
function bootstrapSync(): string | null {
  if (bootstrapTried || typeof XMLHttpRequest === 'undefined') return null;
  bootstrapTried = true;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/director/bootstrap', false);
    xhr.send();
    if (xhr.status === 200) {
      const body = JSON.parse(xhr.responseText) as { token?: unknown };
      if (typeof body.token === 'string' && body.token.length >= 8) { store(body.token); return body.token; }
    }
  } catch { /* another device or offline */ }
  return null;
}

/**
 * Make sure a director token is available before a page renders. On this machine the server hands it out
 * (GET /api/director/bootstrap answers only to same-machine requests), so opening / or /2d
 * without the link works. A stale stored token is replaced when the server issues a different one.
 */
export async function ensureDirectorToken(): Promise<string | null> {
  const existing = takeDirectorToken();
  try {
    const res = await fetch('/api/director/bootstrap', { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token === 'string' && body.token.length >= 8) {
        if (body.token !== existing) store(body.token);
        return body.token;
      }
    }
  } catch { /* offline or another device: fall back to what we have */ }
  return existing;
}

export function forgetDirectorToken(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
