export interface WorkspaceAvatarGeometry {
  rotation: number;
  filledMask: number;
  heavyIndex: number;
  chromeMask: number;
}

/** FNV-1a 32-bit hash for stable, non-cryptographic visual seeding. */
function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Stable seven-cell honeycomb geometry derived only from the Workspace id. */
export function workspaceAvatarGeometry(workspaceId: string): WorkspaceAvatarGeometry {
  const hash = hash32(workspaceId);
  const heavyIndex = (hash >>> 18) % 7;
  const filledMask = ((hash >>> 3) & 0x7f) | 1 | (1 << heavyIndex);
  return {
    rotation: ((hash >>> 28) % 6) * 60,
    filledMask,
    heavyIndex,
    chromeMask: ((hash >>> 10) & 0x7f) | 1,
  };
}
