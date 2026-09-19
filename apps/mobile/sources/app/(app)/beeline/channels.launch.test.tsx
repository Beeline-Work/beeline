import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import { desktopWorkspaceRoute } from '@/buzz/desktop-workbench-state';
import {
  routeBuzzNotificationResponse,
  startNotificationResponseEntries,
} from '@/push/notification-response';
import { resetInitialLandingForTests } from '@/navigation/initial-landing';

const BEELINE_ROOM_ID = 'room-beeline';
const WORKSPACE_ID = 'workspace-mine';
const deckSource = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const rootSource = readFileSync(path.join(__dirname, '..', 'index.tsx'), 'utf8');

beforeEach(() => {
  resetInitialLandingForTests();
});

describe('phone cold launch after the deck replace', () => {
  it('lands on the Room deck and does not restore last-viewed or first-Room', () => {
    expect(rootSource).toContain("router.replace('/beeline/channels')");
    expect(deckSource).not.toContain('loadLastViewedChannel');
    expect(deckSource).not.toContain('desktopWorkspaceRoute');
    expect(deckSource).not.toContain('claimFirstLaunchLanding');
    expect(deckSource).not.toContain('welcomeRoomHref');
    // Those helpers would open #beeline if the deck called them.
    expect(
      desktopWorkspaceRoute(WORKSPACE_ID, [BEELINE_ROOM_ID], BEELINE_ROOM_ID).params,
    ).toEqual({ channelId: BEELINE_ROOM_ID, communityId: WORKSPACE_ID });
  });

  it('does not push the welcome Room after identity is loaded', () => {
    // Trigger that used to fire: claimFirstLaunchLanding returned a landing and
    // the deck pushed `/beeline/chat/${WELCOME_ROOM_ID}`. Masking condition:
    // `@beeline/welcome/landed/${pubkey}` already set. Visible symptom: cold
    // launch opened a Room nobody chose this launch.
    const bootstrap = deckSource.slice(
      deckSource.indexOf('const nextIdentity = await loadBuzzIdentity()'),
      deckSource.indexOf('const storedWorkspaceId = await loadActiveCommunityId'),
    );
    expect(bootstrap).not.toContain('/beeline/chat/');
    expect(bootstrap).not.toContain(WELCOME_ROOM_ID);
    expect(bootstrap).not.toContain(BEELINE_ROOM_ID);
  });

  it('does not route a leftover last notification when this launch had no tap', async () => {
    const route = vi.fn().mockResolvedValue(undefined);
    startNotificationResponseEntries({
      addResponseListener: () => ({ remove() {} }),
      getLastResponse: async () => null,
      getAppState: () => 'active',
      route,
    });
    await Promise.resolve();
    expect(route).not.toHaveBeenCalled();

    const navigate = vi.fn();
    await routeBuzzNotificationResponse(null, {
      router: { navigate },
      handled: new Set(),
      defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      waitForInitialLanding: async () => 'committed',
      suppressPendingInitialLanding: () => undefined,
      clearLastResponse: async () => undefined,
      resolveTarget: async (target) => target,
      log: () => {},
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});
