export type ManageableRole = 'master' | 'admin' | 'member' | undefined | null;

/** Masters and admins can manage Workspace membership, avatar, and settings. */
export function isWorkspaceManagerRole(role: ManageableRole): boolean {
  return role === 'master' || role === 'admin';
}

/** Only a Workspace master may delete it outright. */
export function isWorkspaceMasterRole(role: ManageableRole): boolean {
  return role === 'master';
}
