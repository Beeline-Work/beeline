import { describe, it, expect } from 'vitest';
import { AdmissionOwner } from './admission.js';

const identity = { origin: 'https://example.test', principal: 'ada', sessionEpoch: 1 };
const room = { route: 'phone.readRoom', input: { roomId: 'room-a' } } as const;

describe('phone growth and recovery', () => {
  it('joins identical observations and replaces changed local signatures without reviving old passes', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.focus(1, 'Room', [room]);
    expect(owner.focus(1, 'Room', [room])[0]).toBe(pass);
    owner.spend(room, pass!);
    expect(() => owner.spend(room, owner.focus(1, 'Room', [room])[0]!)).toThrow('inactive pass');
    expect(owner.focus(1, 'Room', [{ ...room, input: { roomId: 'changed' } }])).toHaveLength(1);
    owner.blur();
    expect(owner.focus(1, 'Room', [room])[0]).not.toBe(pass);
    expect(() => owner.spend(room, pass!)).toThrow('inactive pass');
    expect(owner.focus(2, 'Room', [room])[0]).not.toBe(pass);
  });
  it('allows growing key sets and keeps a bounded local-only denial ring', () => {
    const owner = new AdmissionOwner(identity);
    expect(() => owner.focus(1, 'Room', [room, room])).toThrow('duplicate key');
    const many = Array.from({ length: 17 }, (_, i) => ({ ...room, input: { roomId: String(i) } }));
    expect(owner.focus(1, 'Room', many)).toHaveLength(17);
    for (let i = 0; i < 150; i++) expect(() => owner.focus(-1, 'Room', [])).toThrow('invalid generation');
    expect(owner.localDiagnostics()).toHaveLength(100);
    expect(JSON.stringify(owner.localDiagnostics()).length).toBeLessThan(16 * 1024);
  });
});
