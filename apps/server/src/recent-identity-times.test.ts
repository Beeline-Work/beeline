import { describe, expect, it } from 'vitest';
import { RecentIdentityTimes } from './connection-presence.js';

describe('RecentIdentityTimes', () => {
  it('expires old evidence and caps recent identities', () => {
    const times = new RecentIdentityTimes(2, 90_000);
    times.set('first', 1);
    times.set('second', 2);
    times.set('third', 3);
    expect(times.size).toBe(2);
    expect(times.get('first')).toBeUndefined();
    times.set('fourth', 90_004);
    expect(times.get('second')).toBeUndefined();
    expect(times.get('third')).toBeUndefined();
    expect(times.get('fourth')).toBe(90_004);
  });
});
