import { describe, expect, it } from 'vitest';
import {
  connectorOfferCeremonyRoute,
  connectorOfferCompletionRoute,
  googleOfferSignInRoute,
  continueGoogleOffer,
} from './connector-offer-ceremony';

describe('in-chat connector offer ceremony routing', () => {
  it('opens the existing Workbench connect flow with the accepted offer row', () => {
    expect(
      connectorOfferCeremonyRoute({
        workspaceId: 'workspace-1',
        viewerId: 'human-1',
        roomId: 'room-1',
        offerId: 'offer-1',
        connectorType: 'trusty-squire',
        pairedConnectorId: 'connector-row-1',
      }),
    ).toEqual({
      pathname: '/beeline/settings/workbench/connect',
      params: {
        workspaceId: 'workspace-1',
        viewerId: 'human-1',
        roomId: 'room-1',
        offerId: 'offer-1',
        connectorId: 'trusty-squire',
        pairedConnectorId: 'connector-row-1',
      },
    });
  });

  it('returns a completed in-chat ceremony to its Room, while Settings still returns to Workbench', () => {
    expect(connectorOfferCompletionRoute('room-1')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-1' },
    });
    expect(connectorOfferCompletionRoute()).toBe('/beeline/settings/workbench');
  });

  it('routes Room and DM Google offers straight to sign-in and has no helper route without a URL', () => {
    for (const roomId of ['room-1', 'dm-1']) {
      const input = { workspaceId: 'workspace-1', viewerId: 'human-1', roomId,
        offerId: 'offer-1', pairedConnectorId: 'google-account' };
      expect(googleOfferSignInRoute(input)).toBeNull();
      expect(googleOfferSignInRoute({ ...input,
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=one' }))
        .toEqual({ pathname: '/beeline/settings/workbench/connect-signin',
          params: expect.objectContaining({ roomId, connectorId: 'google-account',
            url: 'https://accounts.google.com/o/oauth2/v2/auth?state=one' }) });
    }
  });

  it('retries a missing Google URL directly and never yields a helper ceremony on failure', async () => {
    const input = { workspaceId: 'ws', viewerId: 'owner', roomId: 'room',
      offerId: 'offer', pairedConnectorId: 'google-account' };
    const retry = async () => ({ authorizationUrl: 'https://accounts.google.com/?state=retry' });
    expect(await continueGoogleOffer(input, async () => ({}), retry))
      .toMatchObject({ pathname: '/beeline/settings/workbench/connect-signin' });
    expect(await continueGoogleOffer(input, async () => ({}), async () => ({}))).toBeNull();
    await expect(continueGoogleOffer(input, async () => { throw new Error('offline'); }, retry))
      .rejects.toThrow('offline');
  });
});
