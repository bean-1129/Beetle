// Token comparison, Bearer parsing and loopback detection. Tokens are never logged.
import { createHash, timingSafeEqual } from 'node:crypto';

export function bearerToken(headers: Record<string, unknown>): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 && token.length <= 256 ? token : null;
}

/** Constant-time string equality via sha256 digests (handles unequal lengths). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

export function isLoopback(address: string | undefined | null): boolean {
  if (!address) return false;
  let ip = address.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (ip === '::1' || ip === 'localhost') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** True when the URL host is a loopback address. Used to refuse non-local model endpoints. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return isLoopback(host);
  } catch {
    return false;
  }
}
