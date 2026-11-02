/** Structural JSON codecs generated from contracts. Semantic authorization and
 * family-specific row/byte limits remain the negotiated server adapter's job. */
export type WireShape =
  | { kind: 'json' | 'never' | 'undefined' | 'string' | 'number' | 'boolean' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'template'; texts: readonly string[]; slots: readonly ('string' | 'number')[] }
  | { kind: 'union' | 'intersection'; choices: readonly number[] }
  | { kind: 'array'; item: number }
  | { kind: 'tuple'; items: readonly number[]; min: number }
  | { kind: 'object'; properties: Readonly<Record<string, { node: number; optional: boolean }>>; index?: number };
export type Codec<T> = Readonly<{ parse(value: unknown): T }>;

/** Bounded JSON preflight prevents getters, cycles, nonfinite values, exotic
 * prototypes and oversized payloads before any union backtracking can happen. */
export function assertJsonBudget(value: unknown, maxBytes: number): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  function add(text: string): void {
    if (text.length > maxBytes - bytes) throw new Error('network codec: byte limit');
    for (const character of text) {
      const code = character.codePointAt(0)!;
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    if (bytes > maxBytes) throw new Error('network codec: byte limit');
  }
  function visit(item: unknown, depth: number): void {
    if (++nodes > 32768 || depth > 64) throw new Error('network codec: complexity limit');
    if (item === undefined) return;
    if (item === null || typeof item === 'boolean') { add(JSON.stringify(item)); return; }
    if (typeof item === 'string') {
      if (item.length > maxBytes) throw new Error('network codec: byte limit');
      add(JSON.stringify(item)); return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) { add(String(item)); return; }
    if (typeof item !== 'object' || item === null) throw new Error('network codec: non-JSON value');
    if (ancestors.has(item)) throw new Error('network codec: cyclic value');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error('network codec: non-JSON object');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('network codec: symbol property');
    ancestors.add(item);
    add('[]');
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) throw new Error('network codec: invalid array');
        if (i) add(',');
        visit(descriptor.value, depth + 1);
      }
    } else {
      let first = true;
      for (const key of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('network codec: accessor or non-enumerable field');
        if (descriptor.value === undefined) continue; // optional JS fields disappear on JSON wire
        if (!first) add(',');
        first = false;
        add(JSON.stringify(key)); add(':');
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

export function jsonCodec<T>(shapes: readonly WireShape[], root: number, maxBytes: number): Codec<T> {
  return Object.freeze({ parse(value: unknown): T {
    assertJsonBudget(value, maxBytes);
    let work = 0;
    function matches(id: number, item: unknown): boolean {
      if (++work > 131072) throw new Error('network codec: validation work limit');
      const shape = shapes[id];
      if (!shape) throw new Error('network codec: invalid schema reference');
      switch (shape.kind) {
        case 'json': return item !== undefined;
        case 'never': return false;
        case 'undefined': return item === undefined;
        case 'string': return typeof item === 'string';
        case 'number': return typeof item === 'number';
        case 'boolean': return typeof item === 'boolean';
        case 'literal': return item === shape.value;
        case 'template': {
          if (typeof item !== 'string') return false;
          const [prefix, suffix] = shape.texts;
          if (shape.slots.length !== 1 || prefix === undefined || suffix === undefined)
            throw new Error('network codec: unsupported template');
          if (!item.startsWith(prefix) || !item.endsWith(suffix) || item.length < prefix.length + suffix.length) return false;
          const slot = item.slice(prefix.length, item.length - suffix.length);
          return shape.slots[0] === 'string' || slot.trim().length > 0 && Number.isFinite(Number(slot));
        }
        case 'union': return shape.choices.some(choice => matches(choice, item));
        case 'intersection': return shape.choices.every(choice => matches(choice, item));
        case 'array': return Array.isArray(item) && Array.prototype.every.call(item, (value: unknown) => matches(shape.item, value));
        case 'tuple': return Array.isArray(item) && item.length >= shape.min && item.length <= shape.items.length &&
          Array.prototype.every.call(item, (value: unknown, i: number) => matches(shape.items[i]!, value));
        case 'object': {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
          const record = item as Record<string, unknown>;
          for (const [key, field] of Object.entries(shape.properties)) {
            if (!Object.hasOwn(record, key) || record[key] === undefined) {
              if (field.optional) continue;
            }
            if (!matches(field.node, Object.hasOwn(record, key) ? record[key] : undefined)) return false;
          }
          if (shape.index !== undefined)
            for (const key of Object.keys(record)) if (!matches(shape.index, record[key])) return false;
          return true; // structural DTOs preserve forward-compatible extra JSON fields
        }
      }
    }
    if (!matches(root, value)) throw new Error('network codec: contract mismatch');
    return value as T;
  } });
}
