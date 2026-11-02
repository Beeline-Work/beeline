import { assertJsonBudget } from '../wire-codec.js';

/** Canonical JSON for local keys and immutable admission inputs, never a wire pass. */
export function canonical(value: unknown): string {
  assertJsonBudget(value, 64 * 1024);
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): string {
    if (++nodes > 4096 || depth > 32) throw new Error('input too complex');
    if (typeof item === 'string' && item.length > 64 * 1024) throw new Error('input too large');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null) throw new Error('input must be JSON');
    if (ancestors.has(item)) throw new Error('cyclic input');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error('input must be plain JSON');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('input symbols');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const entries: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor)) throw new Error('input array accessor or hole');
        entries.push(visit(descriptor.value, depth + 1));
      }
      result = `[${entries.join(',')}]`;
    } else {
      const record = item as Record<string, unknown>;
      result = `{${Object.keys(record).sort().flatMap(key => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
        if (!('value' in descriptor)) throw new Error('input accessor');
        return descriptor.value === undefined ? [] : [`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`];
      }).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }
  const result = visit(value, 0);
  let bytes = 0;
  for (const character of result) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  if (bytes > 64 * 1024) throw new Error('input too large');
  return result;
}
