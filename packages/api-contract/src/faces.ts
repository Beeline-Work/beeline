/**
 * The face ceremony vocabulary: the twelve animals a person may choose as
 * their face. The server validates `updateIdentityFace` against this exact
 * set; every identity view exposes the chosen id as `face` (absent when
 * unset). The phone renders `face ?? defaultFaceForSeed(pubkey)`.
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
