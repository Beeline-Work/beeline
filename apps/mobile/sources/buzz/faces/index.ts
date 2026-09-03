/**
 * The face vocabulary on the phone: the twelve animal ids the server validates
 * (`FACE_IDS` in `@beeline/api-contract/phone`), kept local so no screen
 * depends on a freshly built SDK `dist/` (CLAUDE.md, mobile), plus the one
 * seed → face default every tile uses. The drawings themselves live beside
 * this file (`animals.tsx`, `edge.ts`, `face-tile.tsx`) and are composed only
 * by `components/buzz/IdentityMark.tsx`.
 *
 * The order is load-bearing: `defaultFaceForSeed` indexes into it, so
 * reordering would silently give every un-chosen person a different creature.
 */
export const FACE_IDS = [
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
] as const;

export type FaceId = (typeof FACE_IDS)[number];

export function isFaceId(value: unknown): value is FaceId {
  return typeof value === 'string' && (FACE_IDS as readonly string[]).includes(value);
}

/**
 * The face a person wears before they choose one. Speakeasy's
 * `defaultAnimalForUser` verbatim — FNV-1a over the seed, uniform into the
 * twelve — so the same key wears the same animal on this device, on every
 * other member's device, and in the ceremony's pre-selected tile.
 */
export function defaultFaceForSeed(seed: string): FaceId {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const index = (h >>> 0) % FACE_IDS.length;
  return FACE_IDS[index]!;
}

/** `face ?? defaultFaceForSeed(seed)` — the one resolution every tile uses;
 *  an unknown id (a future animal, a typo) falls back rather than blanking. */
export function resolveFace(face: string | undefined, seed: string): FaceId {
  return isFaceId(face) ? face : defaultFaceForSeed(seed);
}
