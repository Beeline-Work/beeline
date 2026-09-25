import React from 'react';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { HeaderIdentitySlot } from './HeaderLadder';
import { IdentityMark, isConnectorLogoUrl } from './IdentityMark';

export function DirectMessageHeaderIdentity({
  isDirectMessage,
  readOnly,
  peerPubkey,
  connectorAvatarUrl,
  kind,
  seed,
  avatarUrl,
  face,
  name,
}: {
  isDirectMessage: boolean;
  readOnly: boolean;
  peerPubkey?: string;
  connectorAvatarUrl?: string;
  kind: 'agent' | 'human';
  seed?: string;
  avatarUrl?: string;
  face?: string;
  name: string;
}) {
  if (
    !isDirectMessage ||
    !peerPubkey ||
    (readOnly && peerPubkey !== SYSTEM_IDENTITY_PUBKEY && !isConnectorLogoUrl(connectorAvatarUrl))
  ) {
    return null;
  }

  return (
    <HeaderIdentitySlot testID="direct-message-header-identity">
      <IdentityMark
        kind={kind}
        seed={seed ?? peerPubkey}
        avatarUrl={avatarUrl}
        face={face}
        name={name}
        size={26}
      />
    </HeaderIdentitySlot>
  );
}
