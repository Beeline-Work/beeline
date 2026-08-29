import type { ChannelMember, ChannelRole, RoomView } from '@beeline/buzz-client';

export type RoomLifecycleAction = 'delete' | 'leave' | null;

export function normalizedRoomRole(member: ChannelMember | undefined): ChannelRole | null {
  if (!member) return null;
  return member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
}

export function roomLifecycleAction(role: ChannelRole | null): RoomLifecycleAction {
  if (role === 'owner') return 'delete';
  return role === 'member' ? 'leave' : null;
}

export function canRenameRoom(role: ChannelRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Client-side mirror of `setRoomRepository`'s own server-side authority check
 * (`packages/buzz-client/src/room-repository.ts`) — the write is rejected
 * either way, but the set/change UI must not even offer itself to a non-admin.
 */
export function canManageRoomRepository(role: ChannelRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

export type RoomRepositoryConfirmation = 'confirmed' | 'pending' | 'contradicted';

/**
 * Wait for the server-owned Room surface to observe an accepted repository
 * write. `none`, `unverified`, stale bindings, and read failures are all
 * pending facts: none can turn relay acceptance into a client error.
 */
export async function confirmRoomRepositoryLink(
  read: () => Promise<Pick<RoomView, 'repository' | 'repositoryResolution'>>,
  published: { readonly key: string; readonly updatedAt?: number },
  options: {
    readonly attempts?: number;
    readonly initialDelayMs?: number;
    readonly sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<RoomRepositoryConfirmation> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 100);
  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const view = await read();
      if (
        view.repositoryResolution === 'repository' &&
        view.repository?.key === published.key
      ) {
        return 'confirmed';
      }
      if (
        view.repositoryResolution === 'repository' &&
        view.repository &&
        published.updatedAt !== undefined &&
        view.repository.updatedAt >= published.updatedAt
      ) {
        return 'contradicted';
      }
    } catch {
      // The relay already accepted the write. An unavailable confirmation
      // authority is pending, not evidence that the write failed.
    }
    if (attempt + 1 < attempts) {
      await sleep(initialDelayMs * 2 ** attempt);
    }
  }
  return 'pending';
}

export function canRemoveRoomParticipant(
  viewerRole: ChannelRole | null,
  targetRole: ChannelRole | null,
  isSelf: boolean,
): boolean {
  if (isSelf || targetRole === 'owner') return false;
  if (viewerRole === 'owner') return targetRole === 'admin' || targetRole === 'member';
  return viewerRole === 'admin' && targetRole === 'member';
}
