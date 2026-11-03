import type { WireShape } from '../wire-codec.js';

/** Build-time-owned schema data, never a network payload or route authority.
 * References remain numeric IDs, including cycles and forward references. */
export type CompactWireShape = 0 | 1 | 2 | 3 | 4 | 5 |
  readonly [6, string | number | boolean | null] |
  readonly [7, readonly string[], readonly (0 | 1)[]] |
  readonly [8 | 9, readonly number[]] |
  readonly [10, number] |
  readonly [11, readonly number[], number] |
  readonly [12, Readonly<Record<string, number>>, number?]|
  readonly [13,readonly (string|number)[],number?];

const primitives = ['json', 'never', 'undefined', 'string', 'number', 'boolean'] as const;

/** Restore the existing validator's complete WireShape representation once
 * at module initialization. No validation rule, root or reference is changed. */
export function expandWireShapes(shapes: readonly CompactWireShape[],fields:readonly string[]=[]): readonly WireShape[] {
  return shapes.map((shape): WireShape => {
    if (typeof shape === 'number') {
      const kind = primitives[shape];
      if (!kind) throw new Error('network codec: invalid compact primitive');
      return { kind };
    }
    switch (shape[0]) {
      case 6: return { kind: 'literal', value: shape[1] };
      case 7: return { kind: 'template', texts: shape[1], slots: shape[2].map(slot => {
        if (slot === 0) return 'string';
        if (slot === 1) return 'number';
        throw new Error('network codec: invalid compact template slot');
      }) };
      case 8: return { kind: 'union', choices: shape[1] };
      case 9: return { kind: 'intersection', choices: shape[1] };
      case 10: return { kind: 'array', item: shape[1] };
      case 11: return { kind: 'tuple', items: shape[1], min: shape[2] };
      case 12: return { kind: 'object', properties: Object.fromEntries(Object.entries(shape[1]).map(([key, ref]) =>
        [key, { node: ref < 0 ? -ref - 1 : ref, optional: ref < 0 }])),
      ...(shape[2] === undefined ? {} : { index: shape[2] }) };
      case 13: {
        if(shape[1].length%2)throw new Error('network codec: invalid compact fields');
        const entries=[];
        for(let i=0;i<shape[1].length;i+=2){
          const key=shape[1][i],ref=shape[1][i+1],name=typeof key==='number'?fields[key]:key;
          if(typeof name!=='string'||typeof ref!=='number')throw new Error('network codec: invalid compact field');
          entries.push([name,{node:ref<0?-ref-1:ref,optional:ref<0}]);
        }
        return {kind:'object',properties:Object.fromEntries(entries),...(shape[2]===undefined?{}:{index:shape[2]})};
      }
      default: throw new Error('network codec: invalid compact schema tag');
    }
  });
}
