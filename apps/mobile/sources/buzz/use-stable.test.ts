import { describe, expect, it } from 'vitest';
import {
  sameMessageRefMap,
  sameSelectedMembers,
  sameStringSet,
  shallowEqualRecord,
} from './use-stable';

describe('render-input identity comparators', () => {
  it('shallowEqualRecord compares flat boolean/string records field-wise', () => {
    expect(shallowEqualRecord({ a: true, b: false }, { a: true, b: false })).toBe(true);
    expect(shallowEqualRecord({}, {})).toBe(true);
    expect(shallowEqualRecord({ a: true }, { a: false })).toBe(false);
    expect(shallowEqualRecord({ a: true }, { a: true, b: false })).toBe(false);
    expect(shallowEqualRecord({ a: 1 }, { a: '1' })).toBe(false);
  });

  it('sameStringSet compares membership, not insertion order', () => {
    const a = new Set(['x', 'y']);
    const b = new Set(['y', 'x']);
    expect(sameStringSet(a, b)).toBe(true);
    expect(sameStringSet(a, new Set(['x', 'z']))).toBe(false);
    expect(sameStringSet(a, new Set(['x']))).toBe(false);
    expect(sameStringSet(a, a)).toBe(true);
  });

  it('sameMessageRefMap requires identical key sets AND message references', () => {
    const alpha = { id: 'a' };
    const beta = { id: 'b' };
    const first = new Map([
      ['a', alpha],
      ['b', beta],
    ]);
    // Same keys, same object references: equal despite fresh Map identity.
    expect(
      sameMessageRefMap(
        first,
        new Map([
          ['b', beta],
          ['a', alpha],
        ]),
      ),
    ).toBe(true);
    // A replaced message object is a real change.
    expect(
      sameMessageRefMap(first, new Map([['a', alpha], ['b', { ...beta }]])),
    ).toBe(false);
    // A removed key is a real change.
    expect(sameMessageRefMap(first, new Map([['a', alpha]]))).toBe(false);
  });

  it('sameSelectedMembers compares pubkey/role/kind/identity per element', () => {
    const identity = { pubkey: 'p1', kind: 'human' as const };
    const roster = [{ pubkey: 'p1', role: 'admin', kind: 'human', identity }];
    expect(sameSelectedMembers(roster, [{ ...roster[0] }])).toBe(true);
    expect(
      sameSelectedMembers(roster, [{ pubkey: 'p1', role: 'member', kind: 'human', identity }]),
    ).toBe(false);
    expect(
      sameSelectedMembers(roster, [
        { pubkey: 'p1', role: 'admin', kind: 'human', identity: { ...identity } },
      ]),
    ).toBe(false);
    expect(sameSelectedMembers(roster, [])).toBe(false);
  });
});
