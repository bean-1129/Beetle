// Digests. Server-side only package, so node:crypto is fine here.
import { createHash } from 'node:crypto';
import { canonicalJson, type WorldSpec } from '@beetle/contracts';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** sha256 hex of canonicalJson(spec). Equal for equal specs regardless of key order. */
export function specDigest(spec: WorldSpec): string {
  return sha256Hex(canonicalJson(spec));
}
