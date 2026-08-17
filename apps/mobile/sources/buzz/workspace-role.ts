export type ManageableRole = 'owner' | 'admin' | 'member' | undefined | null;

/** Owners and admins can manage Workspace membership, avatar, and settings. */
export function isWorkspaceManagerRole(role: ManageableRole): boolean {
  return role === 'owner' || role === 'admin';
}
