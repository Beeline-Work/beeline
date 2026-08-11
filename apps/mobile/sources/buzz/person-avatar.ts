export interface PersonAvatarGeometry {
  headWidth: number;
  headLift: number;
  eyeOffset: number;
  orbitTilt: number;
  orbitGap: number;
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Stable rounded porthole geometry for human identities. */
export function personAvatarGeometry(pubkey: string): PersonAvatarGeometry {
  const hash = hash32(pubkey || 'unknown-person');
  const byte = (shift: number) => (hash >>> shift) & 0xff;
  return {
    headWidth: 31 + (byte(0) % 9),
    headLift: 1 + (byte(8) % 5),
    eyeOffset: 8 + (byte(16) % 4),
    orbitTilt: -16 + (byte(24) % 33),
    orbitGap: 5 + (byte(0) % 7),
  };
}
