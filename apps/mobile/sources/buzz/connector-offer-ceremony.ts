export type ConnectorOfferCeremonyRouteInput = {
  readonly workspaceId: string;
  readonly viewerId: string;
  readonly roomId: string;
  readonly offerId: string;
  readonly connectorType: string;
  readonly pairedConnectorId: string;
};

/** Route an accepted in-chat offer through the existing Workbench ceremony. */
export function connectorOfferCeremonyRoute(input: ConnectorOfferCeremonyRouteInput) {
  return {
    pathname: '/beeline/settings/workbench/connect' as const,
    params: {
      workspaceId: input.workspaceId,
      viewerId: input.viewerId,
      roomId: input.roomId,
      offerId: input.offerId,
      connectorId: input.connectorType,
      pairedConnectorId: input.pairedConnectorId,
    },
  };
}

/** A Google offer never enters the helper pairing ceremony. */
export function googleOfferSignInRoute(input: Omit<ConnectorOfferCeremonyRouteInput, 'connectorType'> & {
  authorizationUrl?: string;
}) {
  if (!input.authorizationUrl) return null;
  return { pathname: '/beeline/settings/workbench/connect-signin' as const,
    params: { workspaceId: input.workspaceId, viewerId: input.viewerId,
      roomId: input.roomId, offerId: input.offerId, connectorId: input.pairedConnectorId,
      connectorName: 'Google Workspace', method: 'oauth', url: input.authorizationUrl } };
}

export async function continueGoogleOffer(
  input: Omit<ConnectorOfferCeremonyRouteInput, 'connectorType'>,
  read: () => Promise<{ authorizationUrl?: string }>,
  retry: () => Promise<{ authorizationUrl?: string }>,
) {
  const current = await read();
  const next = current.authorizationUrl ? current : await retry();
  return googleOfferSignInRoute({ ...input, authorizationUrl: next.authorizationUrl });
}

/** Settings returns to Workbench; an in-chat ceremony returns to its Room. */
export function connectorOfferCompletionRoute(roomId?: string) {
  if (!roomId) return '/beeline/settings/workbench' as const;
  return {
    pathname: '/beeline/chat/[channelId]' as const,
    params: { channelId: roomId },
  };
}
