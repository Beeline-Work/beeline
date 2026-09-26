import { Modal } from '@/modal';

/** The server decides again under a Room lock before deleting. A stale view
 * gets a second, explicit confirmation rather than silently deleting. */
export async function leaveRoomWithConfirmation(
  title: string,
  deletesRoom: boolean,
  leave: (confirmDelete: boolean) => Promise<void>,
): Promise<boolean> {
  const confirm = (lastAdmin: boolean) =>
    Modal.confirm(
      `Leave ${title}?`,
      lastAdmin
        ? `You're the last admin in ${title}. Leaving deletes it for everyone.`
        : 'Other members keep their access.',
      {
        cancelText: 'Cancel',
        confirmText: lastAdmin ? 'Leave and delete' : 'Leave',
        destructive: true,
      },
    );
  if (!(await confirm(deletesRoom))) return false;
  try {
    await leave(deletesRoom);
  } catch (error) {
    if (deletesRoom || !String(error).includes('last_admin_confirmation_required')) throw error;
    if (!(await confirm(true))) return false;
    await leave(true);
  }
  return true;
}
