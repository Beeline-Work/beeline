
import { describe as move15_describe, expect as move15_expect, it as move15_it } from 'vitest';

import { operationShapes as move15_operationShapes, wireShapes as move15_wireShapes } from "./generated-wire-shapes.js";

import { jsonCodec as move15_jsonCodec, type WireShape as move15_WireShape } from "./wire-codec.js";

import { expandWireShapes as move15_expandWireShapes, type CompactWireShape as move15_CompactWireShape } from "./compact-wire-shapes.js";

import { ownerInputs as move15_ownerInputs, ownerInputShapes as move15_ownerInputShapes, ownerResults as move15_ownerResults } from "./private/generated-owner-input-shapes.js";
import { describe as movedDescribe15 } from 'vitest';
movedDescribe15("compact-wire-shapes.test.ts", () => {


const original: readonly move15_WireShape[] = [
  { kind: 'json' }, { kind: 'never' }, { kind: 'undefined' }, { kind: 'string' }, { kind: 'number' }, { kind: 'boolean' },
  { kind: 'literal', value: 'yes' }, { kind: 'literal', value: 0 }, { kind: 'literal', value: false },
  { kind: 'literal', value: true }, { kind: 'literal', value: null },
  { kind: 'template', texts: ['pre-', '-post'], slots: ['string'] },
  { kind: 'template', texts: ['v', ''], slots: ['number'] },
  { kind: 'union', choices: [3, 4] }, { kind: 'intersection', choices: [18, 19] },
  { kind: 'array', item: 3 }, { kind: 'tuple', items: [3, 4], min: 1 },
  { kind: 'object', properties: { requiredZero: { node: 0, optional: false }, optionalZero: { node: 0, optional: true },
    optionalText: { node: 3, optional: true } } },
  { kind: 'object', properties: { name: { node: 3, optional: false } } },
  { kind: 'object', properties: { count: { node: 4, optional: false } } },
  { kind: 'object', properties: {}, index: 0 },
  { kind: 'object', properties: { child: { node: 21, optional: true } } },
  { kind: 'array', item: 23 }, { kind: 'union', choices: [10, 22] },
  { kind: 'tuple', items: [], min: 0 },
  { kind: 'template', texts: ['a', 'b', 'c'], slots: ['string', 'number'] },
  { kind: 'union', choices: [] }, { kind: 'intersection', choices: [] },
];

const packed: readonly move15_CompactWireShape[] = [
  0, 1, 2, 3, 4, 5, [6, 'yes'], [6, 0], [6, false], [6, true], [6, null],
  [7, ['pre-', '-post'], [0]], [7, ['v', ''], [1]], [8, [3, 4]], [9, [18, 19]],
  [10, 3], [11, [3, 4], 1], [12, { requiredZero: 0, optionalZero: -1, optionalText: -4 }],
  [12, { name: 3 }], [12, { count: 4 }], [12, {}, 0], [12, { child: -22 }],
  [10, 23], [8, [10, 22]], [11, [], 0], [7, ['a', 'b', 'c'], [0, 1]], [8, []], [9, []],
];


function verdict(shapes: readonly move15_WireShape[], root: number, value: unknown): string {
  try { move15_jsonCodec(shapes, root, 512).parse(value); return 'accepted'; }
  catch (error) { return (error as Error).message; }
}


move15_describe('compact owner schema reconstruction', () => {
  move15_it('exactly restores every WireShape variant, optional node zero, index zero and cyclic reference IDs', () => {
    move15_expect(move15_expandWireShapes(packed)).toEqual(original);
    move15_expect(move15_expandWireShapes(packed)[17]).not.toHaveProperty('index');
    move15_expect(move15_expandWireShapes(packed)[20]).toHaveProperty('index', 0);
  });

  move15_it('preserves own object field names without prototype mutation', () => {
    const fields: Record<string, number> = JSON.parse('{"__proto__":-1,"constructor":3,"toString":4}');
    const [shape] = move15_expandWireShapes([[12, fields]]);
    move15_expect(shape).toEqual({ kind: 'object', properties: Object.fromEntries([
      ['__proto__', { node: 0, optional: true }], ['constructor', { node: 3, optional: false }], ['toString', { node: 4, optional: false }],
    ]) });
    if (shape?.kind !== 'object') throw new Error('expected object fixture');
    move15_expect(Object.hasOwn(shape.properties, '__proto__')).toBe(true);
    move15_expect(Object.getPrototypeOf(shape.properties)).toBe(Object.prototype);
  });

  move15_it('preserves acceptance and refusal behavior, including preflight protections and recursive validation work bounds', () => {
    const expanded = move15_expandWireShapes(packed);
    const getter = Object.defineProperty({}, 'name', { enumerable: true, get() { throw new Error('must not invoke getter'); } });
    const cyclic: Record<string, unknown> = {}; cyclic.child = cyclic;
    const samples: unknown[] = [undefined, null, true, false, 0, 1, NaN, 'yes', 'other', 'pre--post', 'pre-middle-post',
      'v1', 'v', 'vno', [], ['x'], ['x', 2], ['x', 'wrong'], [null], [[null]], {}, { name: 'A' },
      { name: 'A', count: 2 }, { name: false, count: 2 }, { requiredZero: null }, { requiredZero: 1, optionalZero: null },
      { requiredZero: 1, optionalText: false }, { child: { child: {} } }, getter, cyclic, { large: 'x'.repeat(600) },
      Object.create({ inherited: 'field' })];
    for (let root = 0; root < original.length; root++) for (const sample of samples)
      move15_expect(verdict(expanded, root, sample), `schema ${root}`).toBe(verdict(original, root, sample));
  });

  move15_it('fails closed on unsupported primitive, tag or template-slot codes', () => {
    for (const data of [[99], [[99]], [[7, ['a', 'b'], [2]]]])
      move15_expect(() => move15_expandWireShapes(data as unknown as readonly move15_CompactWireShape[])).toThrow('network codec: invalid compact');
  });

  move15_it('reconstructs the complete generated owner graph from the unchanged authoritative full registry', () => {
    // Independent graph projection compares all current generated nodes and
    // both root maps; a changed reference/optional/index silently weakening a
    // real owner route must fail, even if representative payloads still pass.
    const expected: move15_WireShape[] = [], ids = new Map<number, number>();
    const project = (id: number): number => {
      const found = ids.get(id); if (found !== undefined) return found;
      const next = expected.length; ids.set(id, next); expected.push({ kind: 'never' });
      const source = move15_wireShapes[id]!;
      let node: move15_WireShape = source;
      switch (source.kind) {
        case 'union': case 'intersection': node = { ...source, choices: source.choices.map(project) }; break;
        case 'array': node = { ...source, item: project(source.item) }; break;
        case 'tuple': node = { ...source, items: source.items.map(project) }; break;
        case 'object': node = { ...source, properties: Object.fromEntries(Object.entries(source.properties).map(([key, field]) =>
          [key, { node: project(field.node), optional: field.optional }])),
        ...(source.index === undefined ? {} : { index: project(source.index) }) }; break;
      }
      expected[next] = node;
      return next;
    };
    const inputs = Object.fromEntries(Object.keys(move15_ownerInputs).map(route => [route, project(move15_operationShapes[route as keyof typeof move15_operationShapes].input as number)]));
    const results = Object.fromEntries(Object.keys(move15_ownerResults).map(route => [route, project(move15_operationShapes[route as keyof typeof move15_operationShapes].output)]));
    move15_expect(move15_ownerInputs).toEqual(inputs);
    move15_expect(move15_ownerResults).toEqual(results);
    move15_expect(move15_ownerInputShapes).toEqual(expected);
  });
});
});
