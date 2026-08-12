export interface AgentAvatarGeometry {
  /** Faceted abdomen silhouette. */
  bodyVariant: number;
  /** Angular wing assembly. */
  wingVariant: number;
  /** Bands are the strongest small-size bee cue. */
  stripeCount: number;
  /** Slants the bands without softening their machined edges. */
  stripeSkew: number;
  /** Rotates the complete mark within its chamfered frame. */
  rotation: number;
  /** Selects one of the neutral body metals. */
  bodyTone: number;
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

/** Stable abstract bee geometry derived from cosmetic seed or pubkey. */
export function agentAvatarGeometry(seed: string): AgentAvatarGeometry {
  const value = seed || 'unknown-agent';
  const baseHash = hash32(value);
  const bodyHash = mix32(baseHash ^ 0x9e3779b9);
  const wingHash = mix32(baseHash ^ 0x85ebca6b);
  const stripeHash = mix32(baseHash ^ 0xc2b2ae35);
  const angleHash = mix32(baseHash ^ 0x27d4eb2f);
  return {
    bodyVariant: bodyHash % 3,
    wingVariant: wingHash % 3,
    stripeCount: 2 + (stripeHash % 3),
    stripeSkew: -6 + ((stripeHash >>> 8) % 13),
    rotation: -8 + (angleHash % 17),
    bodyTone: (bodyHash >>> 8) % 3,
  };
}
