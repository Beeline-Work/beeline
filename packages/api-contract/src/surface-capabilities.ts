/**
 * What each agent surface may do, as one table (C94).
 *
 * A Room is the conversational surface and a corner is where work lands, so the
 * standing invariant is simple: **whatever a Room may do, a corner may also
 * do.** It used to be inverted. A granted command in a Room ran outside the
 * sandbox with the operator's live project as its cwd, while a corner could only
 * touch its own worktree — which made the Room the more powerful surface for
 * host work, and is exactly why one agent did the repository half of a job in
 * its corner and the host half in the Room.
 *
 * The conditions that decide this used to be scattered across the OS sandbox,
 * the grant runner and the tool policy. They live here instead, as data, and
 * `surface-capabilities.test.ts` asserts the invariant row by row so the build
 * refuses an inversion rather than a reviewer having to notice one.
 *
 * This is a product boundary, not a confinement perimeter: see
 * `apps/body/src/bwrap-sandbox.ts` for what the mount namespace does and does
 * not constrain. `reach-network` is true on both surfaces because no surface
 * unshares the network — every harness has to reach its model API.
 */
export const AGENT_SURFACES = ['room', 'corner'] as const;
export type AgentSurface = (typeof AGENT_SURFACES)[number];

export const SURFACE_CAPABILITIES = [
  /** Read the repository copy the surface was opened over. */
  'read-repository',
  /** Write the session's own scratch: TMPDIR and the `agent-home.ts` overlay. */
  'write-scratch',
  /** Write the corner worktree that becomes a branch and a pull request. */
  'write-worktree',
  /** Write the canonical checkout the operator works in. */
  'write-checkout',
  /** Run a command that can change the live host outside the surface's own tree. */
  'run-host-command',
  /** Receive a named secret out of the operator's store, in a command's env. */
  'read-secret',
  /** Reach the network. */
  'reach-network',
] as const;
export type SurfaceCapability = (typeof SURFACE_CAPABILITIES)[number];

export const SURFACE_CAPABILITY_TABLE: Readonly<
  Record<AgentSurface, Readonly<Record<SurfaceCapability, boolean>>>
> = {
  room: {
    'read-repository': true,
    'write-scratch': true,
    'write-worktree': false,
    'write-checkout': false,
    'run-host-command': false,
    'read-secret': true,
    'reach-network': true,
  },
  corner: {
    'read-repository': true,
    'write-scratch': true,
    'write-worktree': true,
    'write-checkout': true,
    'run-host-command': true,
    'read-secret': true,
    'reach-network': true,
  },
};

export function surfaceAllows(surface: AgentSurface, capability: SurfaceCapability): boolean {
  return SURFACE_CAPABILITY_TABLE[surface][capability];
}

/** A Room row has no parent; a corner hangs under its top-level Room. */
export function surfaceForRoom(isCorner: boolean): AgentSurface {
  return isCorner ? 'corner' : 'room';
}

/**
 * What a grant on this surface licensed, for the Room's record. A scroll-back
 * has to read as an account of what happened, so the line says whether the
 * command could only read, or could write and act on the live host.
 */
export function surfaceGrantBoundary(surface: AgentSurface): string {
  return surfaceAllows(surface, 'run-host-command')
    ? 'free to write the worktree and act on the host'
    : 'reads only outside its scratch';
}
