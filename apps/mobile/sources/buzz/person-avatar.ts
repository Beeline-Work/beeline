export interface PersonAvatarGeometry {
  petalCount: number;
  petalLength: number;
  petalWidth: number;
  rotation: number;
  petalTone: number;
  arrangement: number;
  centerRadius: number;
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Stable faceted human-mark geometry for human identities. */
export function personAvatarGeometry(pubkey: string): PersonAvatarGeometry {
  const hash = hash32(pubkey || 'unknown-person');
  const byte = (shift: number) => (hash >>> shift) & 0xff;
  return {
    petalCount: 5 + (byte(0) % 4),
    petalLength: 27 + (byte(8) % 7),
    petalWidth: 15 + (byte(16) % 6),
    rotation: byte(24) % 36,
    petalTone: byte(8) % 2,
    arrangement: byte(16) % 2,
    centerRadius: 11 + (byte(24) % 5),
  };
}
