import * as Haptics from 'expo-haptics';
import { Modal } from '@/modal';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { openRandomNamedCorner } from './open-random-corner';
import { CORNER_LABEL } from './vocabulary';

/**
 * Long-press of a Room-list row's corner glyph: the same action as long-pressing
 * the Room's own corners door — a randomly named human corner, created through
 * `createHumanCorner`, then opened. `createCorner` is null while the list has
 * no transport yet; the press then explains itself instead of doing nothing.
 */
export async function openRoomListCorner(input: {
  roomId: string;
  createCorner: ((roomId: string, title: string) => Promise<string>) | null;
  openCorner: (cornerId: string, title: string) => void;
}): Promise<void> {
  const { createCorner } = input;
  if (!createCorner) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Modal.alert(
      'Not connected yet',
      `A new ${CORNER_LABEL} could not be opened because the app is still connecting to the server. Try again in a moment.`,
    );
    return;
  }
  try {
    await openRandomNamedCorner({
      createCorner,
      roomId: input.roomId,
      openCorner: (cornerId, title) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        input.openCorner(cornerId, title);
      },
    });
  } catch (err) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Modal.alert(`Could not open ${CORNER_LABEL}`, phoneOperationFailureReason(err));
  }
}
