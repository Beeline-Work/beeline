import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FACE_IDS, defaultFaceForSeed, isFaceId, resolveFace } from './faces';

/** Ninety-six hex pubkeys with real entropy (a repeated two-char pattern
 *  collapses FNV-1a onto a handful of buckets and proves nothing). */
const PUBKEYS = Array.from({ length: 96 }, (_, index) =>
  createHash('sha256').update(`pubkey-${index}`).digest('hex'),
);

/**
 * Speakeasy's `defaultAnimalForUser`, restated independently here (its
 * catalogue order and its FNV-1a) so a drift in either our `FACE_IDS` order or
 * our hash would show up as a different creature for the same seed. The two
 * products must agree: a person who has not chosen a face wears the same one
 * on every device that draws them.
 */
const SPEAKEASY_FREE_AVATARS = [
  'fox', 'owl', 'pigeon', 'hare', 'stag', 'whale',
  'moth', 'octopus', 'heron', 'bear', 'cat', 'bat',
];
function speakeasyDefaultAnimalForUser(userId: string): string {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return SPEAKEASY_FREE_AVATARS[(h >>> 0) % SPEAKEASY_FREE_AVATARS.length]!;
}

describe('faces', () => {
  it('names exactly the twelve animals of the shared contract, in order', () => {
    expect([...FACE_IDS]).toEqual(SPEAKEASY_FREE_AVATARS);
    expect(isFaceId('owl')).toBe(true);
    expect(isFaceId('dragon')).toBe(false);
    expect(isFaceId(undefined)).toBe(false);
  });

  it('derives a stable default face from the seed', () => {
    const seed = 'a'.repeat(64);
    expect(defaultFaceForSeed(seed)).toBe(defaultFaceForSeed(seed));
    expect(isFaceId(defaultFaceForSeed(seed))).toBe(true);
    expect(isFaceId(defaultFaceForSeed(''))).toBe(true);
    const spread = new Set(
      Array.from({ length: 200 }, (_, index) => defaultFaceForSeed(`seed-${index}`)),
    );
    expect(spread.size).toBe(FACE_IDS.length);
  });

  it('is Speakeasy’s FNV-1a-into-twelve, creature for creature', () => {
    for (const pubkey of PUBKEYS) {
      expect(defaultFaceForSeed(pubkey)).toBe(speakeasyDefaultAnimalForUser(pubkey));
    }
    expect(new Set(PUBKEYS.map(defaultFaceForSeed)).size).toBe(FACE_IDS.length);
  });

  it('lets a chosen face override the default, and ignores one it does not know', () => {
    const seed = PUBKEYS[5]!;
    const other = FACE_IDS.find((id) => id !== defaultFaceForSeed(seed))!;
    expect(resolveFace(other, seed)).toBe(other);
    expect(resolveFace(undefined, seed)).toBe(defaultFaceForSeed(seed));
    expect(resolveFace('dragon', seed)).toBe(defaultFaceForSeed(seed));
    expect(resolveFace('', seed)).toBe(defaultFaceForSeed(seed));
  });
});
