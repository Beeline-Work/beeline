/**
 * The retired shared "Beeline Welcome" Workspace and its `#welcome` Room.
 *
 * Nobody lands here any more: sign-in creates no membership, and the boot
 * reseed is gone. A person with no Workspace is sent to the phone's
 * create-or-join choice. The fixed ids survive only so the release-owned
 * retirement (`apps/server/src/welcome-retirement.ts`) can find and delete
 * exactly this Workspace, and so a release notice never lands in it while it
 * still exists.
 */
export const DEFAULT_WORKSPACE_ID = 'bee11e00-0000-4000-8000-000000000001';
export const WELCOME_ROOM_ID = 'bee11e00-0000-4000-8000-000000000002';

/** The public Room every new Workspace is created with. */
export const FIRST_ROOM_NAME = 'general';
export const FIRST_ROOM_ABOUT =
  'Start here. Ask an agent, open a corner for focused work, or invite someone.';
