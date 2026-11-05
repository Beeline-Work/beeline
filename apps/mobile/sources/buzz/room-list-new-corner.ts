import * as Haptics from 'expo-haptics';
import { Modal } from '@/modal';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import {
  newCornerOpenAttempt,
  openRandomNamedCorner,
  type CornerOpenAttempt,
} from './open-random-corner';
import { cornerOpenUnreachable, isCornerOpenUnreachable } from './corner-open-status';
import { CORNER_LABEL } from './vocabulary';

/**
 * A failed corner open, said out loud. When the server never answered (the
 * request timed out or the network refused it), the global banner owns recovery.
 * A server refusal keeps its own reason.
 */
export function alertCornerOpenFailure(error: unknown, roomId: string, retry: () => void): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  const unreachable = isCornerOpenUnreachable(error);
  if (unreachable) {
    cornerOpenUnreachable(roomId, unreachable.timedOut, retry);
    return;
  }
  Modal.alert(`Could not open ${CORNER_LABEL}`, phoneOperationFailureReason(error));
}

/**
 * Long-press of a Room-list row's corner glyph: the same action as long-pressing
 * the Room's own corners door — a randomly named human corner, created through
 * `createHumanCorner`, then opened. `createCorner` is null while the list has
 * no transport yet; the press then explains itself instead of doing nothing.
 * `retry` re-enters the caller with the failed attempt.
 */
export async function openRoomListCorner(input: {
  roomId: string;
  createCorner: ((roomId: string, title: string, cornerId: string) => Promise<string>) | null;
  openCorner: (cornerId: string, title: string) => void;
  attempt?: CornerOpenAttempt;
  retry: (attempt: CornerOpenAttempt) => void;
}): Promise<void> {
  const { createCorner } = input;
  if (!createCorner) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Modal.alert(
      `Could not open ${CORNER_LABEL}`,
      `A new ${CORNER_LABEL} could not be opened while Rooms are loading. Try again.`,
    );
    return;
  }
  const attempt = input.attempt ?? newCornerOpenAttempt();
  try {
    await openRandomNamedCorner({
      createCorner,
      roomId: input.roomId,
      attempt,
      openCorner: (cornerId, title) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        input.openCorner(cornerId, title);
      },
    });
  } catch (err) {
    alertCornerOpenFailure(err, input.roomId, () => input.retry(attempt));
  }
}
