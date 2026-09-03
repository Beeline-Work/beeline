/**
 * The face ceremony vocabulary on the phone. The same twelve animal ids the
 * server validates (`FACE_IDS` in `@beeline/api-contract/phone`); kept local
 * so no screen depends on a freshly built SDK `dist/` (CLAUDE.md, mobile).
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
 * The face a person wears before they choose one: deterministic from the
 * identity seed (pubkey), so the same person sees the same default on every
 * device and the ceremony can arrive pre-selected.
 */
export function defaultFaceForSeed(seed: string): FaceId {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return FACE_IDS[hash % FACE_IDS.length]!;
}
