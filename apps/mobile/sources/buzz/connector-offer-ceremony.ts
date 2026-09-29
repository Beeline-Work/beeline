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

/** Settings returns to Workbench; an in-chat ceremony returns to its Room. */
export function connectorOfferCompletionRoute(roomId?: string) {
  if (!roomId) return '/beeline/settings/workbench' as const;
  return {
    pathname: '/beeline/chat/[channelId]' as const,
    params: { channelId: roomId },
  };
}
