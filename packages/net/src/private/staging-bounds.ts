const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** One logical primary (1MiB) plus 256KiB future work, at most 17 entries.
 * Without a position callback the first insertion is primary. Positioned
 * authority work uses its earliest source position, retaining insertion order
 * on ties. Never reorder the caller's map or change its delivery order. */
export function stagingWithinBudget<T>(values: Iterable<T>, size: (value: T) => number,
  position?: (value: T) => number): boolean {
  let count = 0, total = 0, primaryBytes = 0, primaryPosition = Infinity;
  for (const value of values) {
    const bytes = size(value), rank = position ? position(value) : count;
    if (count === 0 || rank < primaryPosition) { primaryBytes = bytes; primaryPosition = rank; }
    if (++count > 17 || bytes > 1024 * 1024) return false;
    total += bytes;
  }
  return total <= 1280 * 1024 && total - primaryBytes <= 256 * 1024;
}

/** Preserve the existing insertion-order history: replacing a duplicate does
 * not refresh its position and cannot keep old entries alive indefinitely. */
export function remember<K, V>(history: Map<K, V>, key: K, value: V): void {
  history.set(key, value);
  while (history.size > 128) history.delete(history.keys().next().value!);
}
