import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const renderSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Modal: host('Modal'),
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', inset: 0 },
    create: (factory: unknown) =>
      typeof factory === 'function' ? (factory as (theme: any) => unknown)({ buzz: {} }) : factory,
  },
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => ReactModule.createElement('HullSurface', props, props.children),
  };
});

vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return {
    IdentityMark: (props: any) => {
      renderSpy();
      return ReactModule.createElement('IdentityMark', props);
    },
  };
});

import { RoomRosterSheet } from './RoomRosterSheet';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});

afterAll(() => vi.restoreAllMocks());

describe('RoomRosterSheet', () => {
  it('renders a changed collapsed online verdict through the shared modal boundary', () => {
    const members = new Map([['agent', { pubkey: 'agent', role: 'member' }]]);
    const rosterSections = {
      people: [],
      agents: [
        {
          pubkey: 'agent',
          name: 'Ox',
          handle: 'ox',
          kind: 'agent' as const,
          agent: { pubkey: 'agent', displayName: 'Ox' },
        },
      ],
    };
    const onClose = vi.fn();
    const onRemove = vi.fn();
    const personProfileByPubkey = new Map();

    function ChatHarness({ liveEventId, online }: { liveEventId: string; online: boolean }) {
      void liveEventId;
      return (
        <RoomRosterSheet
          bottomInset={0}
          isDirectMessage={false}
          memberByPubkey={members}
          membershipActionPubkey={null}
          membershipError={null}
          onClose={onClose}
          onRemove={onRemove}
          onlineByPubkey={{ agent: online }}
          parentChannelId={null}
          personProfileByPubkey={personProfileByPubkey}
          rosterSections={rosterSections}
          total={1}
          userPubkey="viewer"
          viewerRole="owner"
          visible
        />
      );
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<ChatHarness liveEventId="agent-draft-1" online />);
    });
    act(() => {
      renderer.update(<ChatHarness liveEventId="agent-draft-2" online={false} />);
    });

    expect(renderSpy).toHaveBeenCalledTimes(2);
  });
});
