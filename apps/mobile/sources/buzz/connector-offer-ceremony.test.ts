import { describe, expect, it } from 'vitest';
import {
  connectorOfferCeremonyRoute,
  connectorOfferCompletionRoute,
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
});
