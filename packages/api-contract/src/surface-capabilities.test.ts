import { describe, expect, it } from 'vitest';
import {
  AGENT_SURFACES,
  SURFACE_CAPABILITIES,
  SURFACE_CAPABILITY_TABLE,
  surfaceAllows,
  surfaceForRoom,
  surfaceGrantBoundary,
} from './surface-capabilities.js';

/**
 * C94. The standing invariant, asserted row by row rather than left to a
 * reviewer's eye: a corner may do everything a Room may. It was inverted in
 * production — a granted command in a Room ran on the live host while a corner
 * could only touch its worktree — so the build refuses that shape now.
 */
describe('agent surface capabilities', () => {
  it('lets a corner do everything a Room can, for every capability', () => {
    const inversions = SURFACE_CAPABILITIES.filter(
      (capability) => surfaceAllows('room', capability) && !surfaceAllows('corner', capability),
    );
    expect(inversions).toEqual([]);
  });

  it('covers every capability on every surface, with no gaps to read as false', () => {
    for (const surface of AGENT_SURFACES) {
      expect(Object.keys(SURFACE_CAPABILITY_TABLE[surface]).sort()).toEqual(
        [...SURFACE_CAPABILITIES].sort(),
      );
    }
  });

  it('gives the corner the host work a Room may not do, and keeps the Room its scratch', () => {
    expect(surfaceAllows('room', 'read-repository')).toBe(true);
    expect(surfaceAllows('room', 'write-scratch')).toBe(true);
    expect(surfaceAllows('room', 'write-checkout')).toBe(false);
    expect(surfaceAllows('room', 'run-host-command')).toBe(false);
    expect(surfaceAllows('corner', 'run-host-command')).toBe(true);
    expect(surfaceAllows('corner', 'write-worktree')).toBe(true);
  });

  it('names the boundary a grant on each surface licensed', () => {
    expect(surfaceForRoom(false)).toBe('room');
    expect(surfaceForRoom(true)).toBe('corner');
    expect(surfaceGrantBoundary('room')).toBe('reads only outside its scratch');
    expect(surfaceGrantBoundary('corner')).toBe(
      'free to write the worktree and act on the host',
    );
  });
});
