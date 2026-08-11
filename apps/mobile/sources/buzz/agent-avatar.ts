export interface AgentAvatarGeometry {
  rotation: number;
  inset: number;
  cut: number;
  bars: [number, number, number];
}

/** Stable geometry derived from display-only soul seed or cryptographic pubkey. */
export function agentAvatarGeometry(seed: string): AgentAvatarGeometry {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const byte = (shift: number) => (hash >>> shift) & 0xff;
  return {
    rotation: (byte(0) % 8) * 45,
    inset: 8 + (byte(8) % 8),
    cut: 20 + (byte(16) % 18),
    bars: [18 + (byte(0) % 38), 18 + (byte(8) % 38), 18 + (byte(16) % 38)],
  };
}
