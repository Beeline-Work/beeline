import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceMemberGrantView } from '@beeline/api-contract/phone';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

const theme = vi.hoisted(() => ({
  buzz: {
    type: {
      body: { fontSize: 16 },
      meta: { fontSize: 13 },
      machine: { fontSize: 13 },
    },
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    layout: { row: 64 },
    radius: 3,
    border: '#333',
    borderStrong: '#555',
    textMuted: '#888',
    textPrimary: '#fff',
    textSecondary: '#ccc',
    accent: '#d7af5f',
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { hairlineWidth: 1, create: (factory: (t: unknown) => unknown) => factory(theme) },
  useUnistyles: () => ({ theme }),
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}), ledger: () => ({}) },
}));
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

import { MemberGrantRow } from './MemberGrantRow';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: WorkspaceMemberGrantView = {
  grantId: 'g-1',
  kind: 'repository',
  target: 'beeline-work/beeline',
  reason: 'ship the profile pass',
  status: 'approved',
  requestedBy: { pubkey: 'b'.repeat(64), kind: 'human', name: 'Alex', handle: 'alex' },
  decidedBy: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Charles' },
  roomId: '22222222-2222-4222-8222-222222222222',
  createdAt: 1_756_900_000,
  decidedAt: 1_756_900_060,
  auto: false,
  agent: { pubkey: 'c'.repeat(64), kind: 'agent', name: 'Clara', handle: 'clara' },
};

function render(grant: WorkspaceMemberGrantView, roomName?: string): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<MemberGrantRow grant={grant} roomName={roomName} />);
  });
  return renderer;
}

function detailLines(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findByProps({ testID: 'member-grant-g-1-details' })
    .findAllByType('Text' as any)
    .map((node: any) => String(node.props.children));
}

describe('MemberGrantRow', () => {
  it('states the target, reason, and provenance, and only discloses on tap', () => {
    const renderer = render(BASE, 'ship-the-slab');
    const head = renderer.root.findByProps({ testID: 'member-grant-g-1' });
    expect(head.props.title).toBe('beeline-work/beeline');
    expect(head.props.description).toBe('ship the profile pass');
    expect(head.props.descriptionDetail).toMatch(/^approved by Charles, .+ · standing$/);
    expect(renderer.root.findAllByProps({ testID: 'member-grant-g-1-details' })).toHaveLength(0);
    act(() => head.props.onPress());
    expect(detailLines(renderer)).toContain('Requested by @alex');
    expect(detailLines(renderer)).toContain('Room ship-the-slab');
  });

  it('falls back to the Room id and shows a bound script when there is one', () => {
    const grant: WorkspaceMemberGrantView = {
      ...BASE,
      kind: 'command',
      target: 'python3 fix.py',
      status: 'once',
      auto: true,
      script: {
        path: 'fix.py',
        sha256: 'd'.repeat(64),
        bytes: 27,
        contents: 'print("repair the fixture")\n',
      },
    };
    const renderer = render(grant);
    const head = renderer.root.findByProps({ testID: 'member-grant-g-1' });
    expect(head.props.descriptionDetail).toMatch(
      /^approved by Charles, .+ · one-time · auto-approved$/,
    );
    act(() => head.props.onPress());
    const lines = detailLines(renderer);
    expect(lines).toContain('Requested by @alex');
    expect(lines).toContain(`Room ${BASE.roomId}`);
    expect(lines.some((line) => line.startsWith('Script fix.py'))).toBe(true);
    expect(lines).toContain('print("repair the fixture")\n');
  });
});
