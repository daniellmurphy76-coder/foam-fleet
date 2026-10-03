/**
 * Room codes: four easy letters ("DUCK") that the host reads out and the other player types.
 * The host's PeerJS id is PEER_PREFIX + the code; guests get their own random ids in a separate lane.
 * No PeerJS in here, so the menu may import this file without loading the online library.
 */
import { CODE_ALPHABET, CODE_LENGTH, PEER_PREFIX } from './protocol';

/**
 * Codes we never hand out (they could read as a rude or scary word). Kept in ROT13 so this file stays
 * kid-safe to read. Typed codes are NOT checked against it: a guest may type anything in the alphabet.
 */
const SKIPPED_ROT13 = 'SHPX PHAG QNZA PENC NAHF OHGG SNEG GHEQ ENCR FRKL FHPX WREX QHZO UNGR CHXR FPHZ QRNQ AHQR'.split(' ');

function rot13(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + 13) % 26) + 65));
}

const SKIPPED = new Set(SKIPPED_ROT13.map(rot13));

const GUEST_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const GUEST_ID_LENGTH = 10;

const scratch = new Uint8Array(1);

/** A fair random number in [0, n), n <= 256 (rejects the bytes that would favor low numbers). */
function randomBelow(n: number): number {
  const limit = 256 - (256 % n);
  for (;;) {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(scratch);
    else scratch[0] = Math.floor(Math.random() * 256);
    if (scratch[0] < limit) return scratch[0] % n;
  }
}

/** A fresh room code: CODE_LENGTH random letters from CODE_ALPHABET, never one of the skipped words. */
export function randomCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomBelow(CODE_ALPHABET.length)];
    if (!SKIPPED.has(code)) return code;
  }
}

/**
 * Turn what a player typed into a room code: trims, ignores case. Returns null when it is not a
 * possible code (wrong length, or any character outside CODE_ALPHABET).
 */
export function normalizeCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) if (CODE_ALPHABET.indexOf(code[i]) < 0) return null;
  return code;
}

/** The host's PeerJS id for a (normalized) room code. */
export function hostPeerId(code: string): string {
  return PEER_PREFIX + code;
}

/** A random id for a joining device. The "g-" keeps it out of the host-code lane (codes have no dash). */
export function guestPeerId(): string {
  let id = PEER_PREFIX + 'g-';
  for (let i = 0; i < GUEST_ID_LENGTH; i++) id += GUEST_ID_CHARS[randomBelow(GUEST_ID_CHARS.length)];
  return id;
}
