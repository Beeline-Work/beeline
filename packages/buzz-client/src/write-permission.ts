/** Room-local intent markers for the read-only → edit-worktree boundary. */
export const WRITE_PERMISSION_REQUEST_TAG = 'buzz-write-permission-request';
export const WRITE_PERMISSION_RESPONSE_TAG = 'buzz-write-permission-response';

export type WritePermissionDecision = 'allow' | 'deny';

