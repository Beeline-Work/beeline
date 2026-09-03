import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import { claimFirstLaunchLanding, welcomeRoomHref } from './welcome-landing';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

describe('first-launch Welcome landing', () => {
  it('opens #welcome in Beeline Welcome on the first launch only', async () => {
    const storage = memoryStorage();
    await expect(claimFirstLaunchLanding('pk-1', storage)).resolves.toEqual({
      workspaceId: DEFAULT_WORKSPACE_ID,
      roomId: WELCOME_ROOM_ID,
    });
    await expect(claimFirstLaunchLanding('pk-1', storage)).resolves.toBeNull();
  });

  it('is claimed per identity', async () => {
    const storage = memoryStorage();
    await claimFirstLaunchLanding('pk-1', storage);
    await expect(claimFirstLaunchLanding('pk-2', storage)).resolves.not.toBeNull();
  });

  it('pins the fixed ids and the chat route', () => {
    expect(WELCOME_ROOM_ID).toBe('bee11e00-0000-4000-8000-000000000002');
    expect(welcomeRoomHref({ workspaceId: DEFAULT_WORKSPACE_ID, roomId: WELCOME_ROOM_ID })).toBe(
      `/beeline/chat/${WELCOME_ROOM_ID}`,
    );
  });
});
