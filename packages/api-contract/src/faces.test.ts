import { describe, expect, it } from 'vitest';
import {
  FACE_IDS,
  FACE_NAMES,
  FACE_SOULS,
  assignSeededAgentIdentity,
  defaultFaceForSeed,
  seededAgentName,
  seededFaceOrder,
  type FaceId,
} from './faces.js';

/** The one name rule the server applies to a human-entered agent name. */
const REASONABLE_NAME = /^\p{L}[\p{L}\p{M}'’ -]*$/u;

function key(index: number): string {
  return `${index}`.padStart(2, '0').repeat(32);
}

describe('the seeded animal vocabulary', () => {
  it('gives every face exactly one soul and one name list', () => {
    expect(Object.keys(FACE_SOULS).sort()).toEqual([...FACE_IDS].sort());
    expect(Object.keys(FACE_NAMES).sort()).toEqual([...FACE_IDS].sort());
    for (const face of FACE_IDS) {
      expect(FACE_SOULS[face].startsWith('You are')).toBe(true);
      expect(FACE_NAMES[face].length).toBeGreaterThan(0);
    }
  });

  it('names every animal with a name the server would accept', () => {
    for (const face of FACE_IDS) {
      for (const name of FACE_NAMES[face]) {
        expect(name).toMatch(REASONABLE_NAME);
        expect(name.length).toBeLessThanOrEqual(32);
      }
    }
  });

  it('orders the twelve stably per key, and not alphabetically', () => {
    expect(seededFaceOrder(key(1))).toEqual(seededFaceOrder(key(1)));
    expect([...seededFaceOrder(key(1))].sort()).toEqual([...FACE_IDS].sort());
    expect(seededFaceOrder(key(1))).not.toEqual(seededFaceOrder(key(2)));
    expect(seededFaceOrder(key(1))).not.toEqual([...FACE_IDS].sort());
  });
});

describe('assignSeededAgentIdentity', () => {
  function joinWorkspace(count: number): Array<{ face: FaceId; name: string; soul: string }> {
    const assigned: Array<{ face: FaceId; name: string; soul: string }> = [];
    for (let index = 0; index < count; index++) {
      assigned.push(
        assignSeededAgentIdentity({
          seed: key(index),
          takenFaces: assigned.map((entry) => entry.face),
          takenNames: assigned.map((entry) => entry.name),
        }),
      );
    }
    return assigned;
  }

  it('gives twelve joining agents twelve distinct animals', () => {
    const assigned = joinWorkspace(12);
    expect(new Set(assigned.map((entry) => entry.face)).size).toBe(12);
    expect(new Set(assigned.map((entry) => entry.name)).size).toBe(12);
  });

  it('only repeats an animal once all twelve are worn', () => {
    const twelve = joinWorkspace(12);
    const thirteenth = assignSeededAgentIdentity({
      seed: key(12),
      takenFaces: twelve.map((entry) => entry.face),
      takenNames: twelve.map((entry) => entry.name),
    });
    expect(thirteenth.face).toBe(defaultFaceForSeed(key(12)));
    expect(FACE_IDS).toContain(thirteenth.face);
    expect(thirteenth.name).toMatch(REASONABLE_NAME);
    expect(thirteenth.soul.length).toBeGreaterThan(0);
    expect(twelve.map((entry) => entry.name)).not.toContain(thirteenth.name);
  });

  it('keeps name, face and soul the same animal', () => {
    for (const entry of joinWorkspace(24)) {
      expect(entry.soul).toBe(FACE_SOULS[entry.face]);
      const roots = FACE_NAMES[entry.face];
      expect(roots.some((root) => entry.name === root || entry.name.startsWith(`${root} `))).toBe(
        true,
      );
    }
  });

  it('counts a person wearing an animal as taking it', () => {
    const everythingButBear = FACE_IDS.filter((face) => face !== 'bear');
    const assigned = assignSeededAgentIdentity({
      seed: key(7),
      takenFaces: everythingButBear,
      takenNames: [],
    });
    expect(assigned.face).toBe('bear');
    expect(assigned.name).toBe('Bruin');
  });

  it('re-derives the same identity for the same roster, so a retry costs no animal', () => {
    const input = { seed: key(3), takenFaces: ['fox', 'owl'], takenNames: ['Foxy', 'Hoots'] };
    expect(assignSeededAgentIdentity(input)).toEqual(assignSeededAgentIdentity(input));
  });
});

describe('seededAgentName', () => {
  it('walks the animal list before repeating', () => {
    expect(seededAgentName('fox', [])).toBe('Foxy');
    expect(seededAgentName('fox', ['Foxy'])).toBe('Reynard');
    expect(seededAgentName('fox', ['foxy ', 'REYNARD'])).toBe('Slick');
    expect(seededAgentName('fox', ['Foxy', 'Reynard', 'Slick'])).toBe('Foxy II');
    expect(seededAgentName('fox', ['Foxy', 'Reynard', 'Slick', 'Foxy II'])).toBe('Foxy III');
  });
});
