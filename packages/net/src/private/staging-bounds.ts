const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** Preserve the existing insertion-order history: replacing a duplicate does
 * not refresh its position and cannot keep old entries alive indefinitely. */
export function remember<K, V>(history: Map<K, V>, key: K, value: V): void {
  history.set(key, value);
  while (history.size > 128) history.delete(history.keys().next().value!);
}
