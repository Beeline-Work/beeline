export interface AgentAvatarGeometry {
  /** Outer hull family. This is the strongest small-size identity cue. */
  hullVariant: number;
  /** Sensor assembly family: cyclops, pair, slit bank, tower, prism, or grid. */
  sensorVariant: number;
  /** Large armor seam layout. */
  armorVariant: number;
  /** Mirrors asymmetric machining without changing the overall agent language. */
  direction: -1 | 1;
  crownDepth: number;
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/** Stable bilateral machine geometry derived from cosmetic seed or pubkey. */
export function agentAvatarGeometry(seed: string): AgentAvatarGeometry {
  const value = seed || 'unknown-agent';
  const baseHash = hash32(value);
  const hullHash = mix32(baseHash ^ 0x9e3779b9);
  const sensorHash = mix32(baseHash ^ 0x85ebca6b);
  const armorHash = mix32(baseHash ^ 0xc2b2ae35);
  const directionHash = mix32(baseHash ^ 0x27d4eb2f);
  return {
    hullVariant: hullHash % 6,
    sensorVariant: sensorHash % 6,
    armorVariant: armorHash % 4,
    direction: (directionHash & 1) === 0 ? -1 : 1,
    crownDepth: 16 + ((hullHash >>> 8) % 13),
  };
}
