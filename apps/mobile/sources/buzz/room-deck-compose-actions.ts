import type { RoomDeckComposeAction } from '@/components/buzz/RoomDeckComposeMenu';

export type RoomDeckComposeTarget = {
  pathname: '/beeline/community' | '/beeline/members';
  params: Record<string, string>;
};

type RoomDeckComposeHandlers = {
  communityId: string | null;
  invitePerson: () => void;
  navigate: (target: RoomDeckComposeTarget) => void;
  openMessagePicker: () => void;
  openRoomCreator: () => void;
};

/** One auditable switch from the five labels to their existing product flows. */
export function runRoomDeckComposeAction(
  action: RoomDeckComposeAction,
  handlers: RoomDeckComposeHandlers,
): void {
  switch (action) {
    case 'message':
      handlers.openMessagePicker();
      return;
    case 'room':
      handlers.openRoomCreator();
      return;
    case 'invite':
      handlers.invitePerson();
      return;
    case 'agent':
      handlers.navigate({
        pathname: '/beeline/members',
        params: {
          ...(handlers.communityId ? { communityId: handlers.communityId } : {}),
          action: 'add-agent',
        },
      });
      return;
    case 'join':
      handlers.navigate({ pathname: '/beeline/community', params: { mode: 'join' } });
  }
}
