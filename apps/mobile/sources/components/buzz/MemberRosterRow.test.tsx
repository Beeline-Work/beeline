import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) =>
      factory({
        buzz: {
          border: '#333',
          layout: { row: 64 },
          space: { sm: 8, md: 12 },
          textMuted: '#777',
          textPrimary: '#fff',
          type: { body: {}, meta: {} },
        },
      }),
    hairlineWidth: 1,
  },
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));
vi.mock('./IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));

import { MemberRosterRow, memberRosterSubtitle } from './MemberRosterRow';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('MemberRosterRow', () => {
  it('formats a human with only the role under the single handle title', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MemberRosterRow
          divider="bottom"
          kind="human"
          name="Builder"
          pubkey="person-key"
          handle="builder"
          role="admin"
          testID="person"
        />,
      );
    });
    expect(
      renderer.root.findAllByType('Text' as any).map((node: any) => node.props.children),
    ).toEqual(['@builder', 'admin']);
    expect(memberRosterSubtitle({ kind: 'human', role: 'owner' })).toBe('owner');
  });

  it('formats an agent with model and owner under the single handle title', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MemberRosterRow
          divider="top"
          kind="agent"
          name="Clara"
          pubkey="agent-key"
          handle="clara"
          model="Sonnet"
          ownerHandle="viewer"
          testID="agent"
        />,
      );
    });
    expect(
      renderer.root.findAllByType('Text' as any).map((node: any) => node.props.children),
    ).toEqual(['@clara', 'Sonnet · by @viewer']);
    expect(memberRosterSubtitle({ kind: 'agent', model: 'Codex', ownerHandle: 'captain' })).toBe(
      'Codex · by @captain',
    );
  });
});
