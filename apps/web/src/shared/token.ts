const KEY = 'beetle.directorToken';

/** Director token from ?token= (stored in sessionStorage, stripped from the URL) or from a previous visit. */
export function takeDirectorToken(): string | null {
  let token: string | null = null;
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl && fromUrl.length >= 8) {
      token = fromUrl;
      sessionStorage.setItem(KEY, fromUrl);
      url.searchParams.delete('token');
      history.replaceState(history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  } catch { /* ignore */ }
  if (!token) {
    try { token = sessionStorage.getItem(KEY); } catch { token = null; }
  }
  return token && token.length >= 8 ? token : null;
}

export function forgetDirectorToken(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
