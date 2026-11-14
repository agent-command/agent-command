/** 32-bit FNV-1a: the one offset basis and prime every stable hash in the game mixes with. */

/** FNV-1a 32-bit offset basis (the hash of no input). */
export const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a 32-bit prime: each mixed value is xored in, then the hash is multiplied by this (Math.imul, mod 2^32). */
export const FNV_PRIME = 0x01000193;

/** FNV-1a over a string's UTF-16 code units, as an unsigned 32-bit integer (callers hashing bytes mix those instead). */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), FNV_PRIME);
  return hash >>> 0;
}
