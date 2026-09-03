/**
 * The one shared Workspace every person lands in, and its one seeded Room.
 * The server seeds both idempotently at boot (`apps/server/src/default-workspace.ts`)
 * and joins every new sign-in to them; the phone opens `#welcome` on an
 * identity's first launch. The ids are fixed so every environment agrees.
 */
export const DEFAULT_WORKSPACE_ID = 'bee11e00-0000-4000-8000-000000000001';
export const DEFAULT_WORKSPACE_NAME = 'Beeline Welcome';
export const WELCOME_ROOM_ID = 'bee11e00-0000-4000-8000-000000000002';
export const WELCOME_ROOM_NAME = 'welcome';
export const WELCOME_ROOM_ABOUT =
  'Questions, feedback, and what you are building. A person answers here.';
