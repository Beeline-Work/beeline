import { describe, expect, it } from 'vitest';
import {
  connectorOfferCeremonyRoute,
  connectorOfferCompletionRoute,
} from './connector-offer-ceremony';

describe('in-chat connector offer ceremony routing', () => {
  it('routes Continue sign-in directly to the sign-in screen for the offered machine', () => {
    expect(
      connectorOfferCeremonyRoute({
        workspaceId: 'workspace-1',
        viewerId: 'human-1',
        roomId: 'room-1',
        offerId: 'offer-1',
        connectorType: 'trusty-squire',
        pairedConnectorId: 'connector-row-1',
        directSignIn: true,
      }),
    ).toEqual({
      pathname: '/beeline/settings/workbench/connect-signin',
      params: {
        workspaceId: 'workspace-1',
        viewerId: 'human-1',
        roomId: 'room-1',
        offerId: 'offer-1',
        connectorId: 'connector-row-1',
        connectorName: 'Trusty Squire',
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

});
