import { describe, expect, it } from 'vitest';
import { FACE_IDS, defaultFaceForSeed, isFaceId } from './faces';

describe('faces', () => {
  it('names exactly the twelve animals of the shared contract, in order', () => {
    expect([...FACE_IDS]).toEqual([
      'fox',
      'owl',
      'pigeon',
      'hare',
      'stag',
      'whale',
      'moth',
      'octopus',
      'heron',
      'bear',
      'cat',
      'bat',
    ]);
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
});
