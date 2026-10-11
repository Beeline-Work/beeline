import { useMemo } from 'react';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from './room-repo-picker';
import type { BuzzRigTransport } from '@/sync/transport';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { useSurfaceSnapshot } from './use-shared-surface';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';

export type GitHubAccessView = { installed: boolean; installations: GitHubInstallationAccess[];
  candidates: RepoCandidate[]; githubReconnectNeeded: boolean };
export type GitHubAccessScope = { relay: string; viewer: string };
const guard = (value: unknown): value is GitHubAccessView => Boolean(value && typeof value === 'object' &&
  Array.isArray((value as GitHubAccessView).installations) &&
  Array.isArray((value as GitHubAccessView).candidates));
const address = ({ relay, viewer }: GitHubAccessScope) =>
  surfaceAddress(relay, viewer, '/github/repositories');
const held = new Map<string, { transport: BuzzRigTransport; scope: GitHubAccessScope }>();
let stopLive: (() => void) | undefined;
let starting = false;
subscribeClientReset(() => { held.clear(); stopLive?.(); stopLive = undefined; starting = false; });
function hold(transport: BuzzRigTransport, scope: GitHubAccessScope) {
  held.set(`${scope.relay}\u0000${scope.viewer}`, { transport, scope });
  if (stopLive || starting) return;
  starting = true;
  const generation = clientResetGeneration();
  void sharedLiveConnection().register([], (event) => {
    if (!('monolithLive' in event)) return;
    const live = event.monolithLive;
    if (live.type !== 'invalidate' || live.roomId !== '' || live.reason !== 'reconnect') return;
    for (const owner of held.values())
      void mobileSurfaceCache.fetch(address(owner.scope), guard,
        () => owner.transport.workspaceGitHubAccess({ refresh: true })).catch(() => undefined);
  }).then((stop) => { if (generation !== clientResetGeneration()) stop();
    else { starting = false; stopLive = stop; } },
    () => { if (generation === clientResetGeneration()) starting = false; });
}

export function useGitHubAccess(scope: GitHubAccessScope | null): GitHubAccessView | null {
  const key = scope && `${scope.relay}\u0000${scope.viewer}`;
  const selected = useMemo(() => scope ? address(scope) : null, [key]);
  return useSurfaceSnapshot(selected, guard);
}

export async function readGitHubAccess(
  transport: BuzzRigTransport, scope: GitHubAccessScope, refresh = false,
): Promise<GitHubAccessView> {
  hold(transport, scope);
  const key = address(scope);
  if (!refresh) {
    const held = await mobileSurfaceCache.read(key, guard);
    if (held) return held;
  }
  const answer = await mobileSurfaceCache.fetch(key, guard,
    () => transport.workspaceGitHubAccess({ refresh }));
  if (answer) return answer;
  const held = mobileSurfaceCache.peek(key, guard);
  if (held) return held;
  throw new Error('GitHub access response was superseded');
}

export async function updateGitHubAccess(scope: GitHubAccessScope, change: (current: GitHubAccessView) => GitHubAccessView) {
  const key = address(scope);
  const held = mobileSurfaceCache.peek(key, guard);
  if (held) await mobileSurfaceCache.write(key, change(held), guard);
}

export async function writeGitHubAccess(scope: GitHubAccessScope, value: GitHubAccessView) {
  await mobileSurfaceCache.write(address(scope), value, guard);
}
