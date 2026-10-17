import { roomHref } from './corner-navigation';
export type ConnectorOfferCeremonyRouteInput = {
  readonly workspaceId: string;
  readonly viewerId: string;
  readonly roomId: string;
  readonly offerId: string;
  readonly connectorType: string;
  readonly pairedConnectorId: string;
  readonly directSignIn?: boolean;
};

/** Route an accepted in-chat offer through the existing Workbench ceremony. */
export function connectorOfferCeremonyRoute(input: ConnectorOfferCeremonyRouteInput) {
  const direct = input.directSignIn && input.connectorType === 'trusty-squire';
  return {
    pathname: direct
      ? '/beeline/settings/workbench/connect-signin' as const
      : '/beeline/settings/workbench/connect' as const,
    params: {
      workspaceId: input.workspaceId,
      viewerId: input.viewerId,
      roomId: input.roomId,
      offerId: input.offerId,
      connectorId: direct ? input.pairedConnectorId : input.connectorType,
      ...(direct ? { connectorName: 'Trusty Squire' } : {}),
      pairedConnectorId: input.pairedConnectorId,
    },
  };
}

/** Settings returns to Workbench; an in-chat ceremony returns to its Room. */
export function connectorOfferCompletionRoute(roomId?: string) {
  if (!roomId) return '/beeline/settings/workbench' as const;
  return roomHref(roomId);
}
