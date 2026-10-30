export type StorePlatform = 'android' | 'ios';
export interface MobileMinimum { minVersion: string; reason: string }

function versionParts(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Unknown native versions and malformed server policy fail open. */
export function storeVersionBelow(installed: unknown, required: unknown): boolean {
  const left = versionParts(installed), right = versionParts(required);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! < right[i]!;
  }
  return false;
}

export function parseMobileMinimum(value: unknown): MobileMinimum | null {
  if (!value || typeof value !== 'object') return null;
  const { minVersion, reason } = value as Record<string, unknown>;
  if (!versionParts(minVersion) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) return null;
  return { minVersion: minVersion as string, reason: reason.trim() };
}
