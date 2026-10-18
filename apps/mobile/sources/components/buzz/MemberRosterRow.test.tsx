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
          accent: 'brass', dialogDanger: 'danger', textSecondary: 'secondary',
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

import { MemberRosterRow, memberRosterModel, memberRosterSubtitle } from './MemberRosterRow';

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

  it('formats an agent as handle and right-aligned model over its owner', () => {
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
    ).toEqual(['@clara', 'Sonnet', '@viewer']);
    const model = renderer.root.findAllByType('Text' as any)[1];
    expect(model.props.style.textAlign).toBe('right');
    expect(memberRosterModel({ kind: 'agent', model: 'openrouter/openai/Codex' })).toBe('Codex');
    expect(memberRosterSubtitle({ kind: 'agent', ownerHandle: 'captain' })).toBe('@captain');
    expect(memberRosterSubtitle({ kind: 'agent' })).toBeUndefined();
  });
});

it('shows the highest window, every warning and provider stop, and no context-only suffix', () => {
  const now = Date.now() / 1000;
  const usage = { updatedAt: now, windows: [
    { rateLimitType: 'five_hour', status: 'allowed' as const, utilization: 0.42, updatedAt: now },
    { rateLimitType: 'seven_day', status: 'allowed' as const, utilization: 0.83, updatedAt: now },
    { rateLimitType: 'seven_day_opus', status: 'allowed' as const, utilization: 0.81, updatedAt: now },
  ] };
  let renderer!: ReactTestRenderer;
  const render = (value: import('@beeline/api-contract/phone').AgentUsage) => act(() => {
    renderer = create(<MemberRosterRow kind="agent" divider="bottom" name="Agent" pubkey="agent" testID="usage" ownerHandle="owner" harness="claude" machine="squire" usage={value} />);
  });
  const text = () => renderer.root.findAllByType('Text' as any)
    .flatMap((node: any) => typeof node.props.children === 'string' ? [node.props.children] : []).join(' ');
  render(usage);
  expect(text()).toContain('week 83%');
  expect(renderer.root.findAllByType('Text' as any).find((node: any) => typeof node.props.children === 'string' && node.props.children.includes('week 83%'))?.props.style.color).toBe('brass');
  expect(text()).toContain('seven day opus 81%');
  expect(text()).not.toContain('5h 42%');
  render({ updatedAt: now, windows: [{ rateLimitType: 'five_hour', status: 'rejected', updatedAt: now, resetsAt: now + 3600 }] });
  expect(text()).toContain('limit reached · back');
  render({ updatedAt: now, windows: [], context: { used: 1, size: 100 } });
  expect(text()).toContain('@owner');
  expect(text()).not.toContain('Claude');
});
