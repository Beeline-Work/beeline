import {
  getChannelCreator,
  isMember,
  resolveRoomRepository,
  type ChannelOpsContext,
} from '@beeline/buzz-client';
import type { AuthServerOptions, AuthTenant } from './server.js';
import type { AuthStore } from './store.js';

type TokenAuthority = NonNullable<AuthServerOptions['authorizeGitHubRoomToken']>;

/**
 * Authorize one daemon token request from current relay truth. The caller's
 * NIP-98 signature proves the agent key; this proves that key is currently in
 * the Room and that a human Room authority bound the exact GitHub repository.
 */
export function createGitHubRoomTokenAuthority(
  roomStore: Pick<AuthStore, 'relayCommunityIdForRoom' | 'resolveCurrentPubkey'>,
): TokenAuthority {
  return async (tenant: AuthTenant, input) => {
    let relayAuthorizationIndex = 0;
    const identity = {
      name: 'room-token-reader',
      publicKey: input.agentPubkey,
      // Never read: the verified exact-request proof below is the HTTP auth.
      secretKey: new Uint8Array(32),
    };
    const ctx: ChannelOpsContext = {
      identity,
      http: {
        baseUrl: tenant.origin,
        host: new URL(tenant.origin).host,
        identity,
        authorization: () => {
          const authorization = input.relayAuthorizations[relayAuthorizationIndex++];
          if (!authorization) throw new Error('Room token relay-read proof budget exhausted');
          return authorization;
        },
      },
    };
    const [communityId, member, repository] = await Promise.all([
      roomStore.relayCommunityIdForRoom(input.roomId),
      isMember(ctx, input.roomId, input.agentPubkey),
      resolveRoomRepository(ctx, input.roomId),
    ]);
    if (!communityId || !tenant.roomCommunityIds.includes(communityId)) {
      return { authorized: false, reason: 'tenant_room_community_mismatch' };
    }
    if (!member) return { authorized: false, reason: 'agent_not_room_member' };
    if (!repository) return { authorized: false, reason: 'room_repository_missing' };
    const remote = repository.binding.remote?.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (!remote) return { authorized: false, reason: 'room_repository_remote_malformed' };
    const authorizedBy = repository.authoredBy ?? (await getChannelCreator(ctx, input.roomId));
    if (!authorizedBy) {
      return { authorized: false, reason: 'room_repository_authority_missing' };
    }
    // Key succession: the binding may have been authored by a key that has
    // since been replaced (device lost, identity recovered onto a new key).
    // Authority stays with the IDENTITY, so the author resolves to its
    // current key; callers compare/look up against the resolved value. The
    // relay-truth author pubkey still rides along as `authorizedBy`.
    let currentAuthorizedBy = authorizedBy;
    try {
      currentAuthorizedBy = await roomStore.resolveCurrentPubkey(
        tenant.community,
        authorizedBy,
      );
    } catch {
      // Resolution is an enrichment, not the authority proof itself — on a
      // lookup failure fall back to the raw author (pre-succession behavior).
    }
    return {
      authorized: true,
      authorizedBy,
      currentAuthorizedBy,
      fullName: `${remote[1]}/${remote[2]}`,
      ...(repository.binding.githubInstallationId
        ? { githubInstallationId: repository.binding.githubInstallationId }
        : {}),
    };
  };
}
