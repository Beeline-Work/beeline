import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

vi.mock('./HeaderLadder', () => ({
  HeaderIdentitySlot: ({ children, ...props }: any) =>
    React.createElement('HeaderIdentitySlot', props, children),
}));
vi.mock('./IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
  isConnectorLogoUrl: (url: string | undefined) =>
    Boolean(url && /\/v1\/connectors\/logo\/[a-z0-9-]+\.svg(?:\?|$)/.test(url)),
}));

import { DirectMessageHeaderIdentity } from './DirectMessageHeaderIdentity';

function render(peerPubkey: string, connectorAvatarUrl?: string) {
  let tree: any;
  act(() => {
    tree = create(
      <DirectMessageHeaderIdentity
        isDirectMessage
        readOnly
        peerPubkey={peerPubkey}
        connectorAvatarUrl={connectorAvatarUrl}
        kind="human"
        name="System"
      />,
    );
  });
  return tree!;
}

describe('read-only DM header identity', () => {
  it('shows the fixed System peer through the app header slot', () => {
    const tree = render(SYSTEM_IDENTITY_PUBKEY);
    expect(tree.root.findByType('HeaderIdentitySlot').props.testID).toBe(
      'direct-message-header-identity',
    );
    expect(tree.root.findByType('IdentityMark').props.seed).toBe(SYSTEM_IDENTITY_PUBKEY);
  });

  it('keeps an ordinary read-only peer hidden', () => {
    expect(render('a'.repeat(64)).toJSON()).toBeNull();
  });

  it('still shows a fixed connector logo', () => {
    const tree = render('b'.repeat(64), '/v1/connectors/logo/github.svg');
    expect(tree.root.findByType('HeaderIdentitySlot')).toBeTruthy();
  });
});
