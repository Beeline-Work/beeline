export interface AgentAvatarGeometry {
  sensorOffset: number;
  aperture: number;
  crown: number;
  struts: [number, number, number];
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Stable bilateral machine geometry derived from cosmetic seed or pubkey. */
export function agentAvatarGeometry(seed: string): AgentAvatarGeometry {
  const hash = hash32(seed || 'unknown-agent');
  const byte = (shift: number) => (hash >>> shift) & 0xff;
  return {
    sensorOffset: 17 + (byte(0) % 8),
    aperture: 5 + (byte(8) % 5),
    crown: 27 + (byte(16) % 13),
    struts: [31 + (byte(0) % 5), 48 + (byte(8) % 5), 65 + (byte(16) % 5)],
  };
}
