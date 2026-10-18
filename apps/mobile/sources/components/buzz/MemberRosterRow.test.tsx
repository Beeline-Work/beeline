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

it('appends usage only at 80% or more, or when stopped or paused', () => {
  const now = Date.now() / 1000;
  const win = (t: string, u: number) => ({ rateLimitType: t, status: 'allowed' as const, utilization: u, updatedAt: now });
  let renderer!: ReactTestRenderer;
  const render = (value: import('@beeline/api-contract/phone').AgentUsage) => act(() => {
    renderer = create(<MemberRosterRow kind="agent" divider="bottom" name="Agent" pubkey="agent" testID="usage" ownerHandle="owner" usage={value} />);
  });
  const texts = () => renderer.root.findAllByType('Text' as any)
    .filter((node: any) => typeof node.props.children === 'string');
  const strings = (node: any): string[] =>
    typeof node === 'string' ? [node] : Array.isArray(node) ? node.flatMap(strings) : node?.children ? strings(node.children) : [];
  const text = () => strings(renderer.toJSON()).join('');
  const colorOf = (part: string) => texts().find((node: any) => node.props.children.includes(part))?.props.style.color;

  render({ updatedAt: now, windows: [win('five_hour', 0.42), win('seven_day', 0.83)] });
  expect(text()).toContain('@owner');
  expect(text()).toContain(' · week 83%');
  expect(text()).not.toContain('5h');
  expect(colorOf('week 83%')).toBe('brass');

  render({ updatedAt: now, windows: [win('five_hour', 0.42)] });
  expect(text()).not.toContain(' · ');

  render({ updatedAt: now, windows: [{ rateLimitType: 'five_hour', status: 'rejected', updatedAt: now, resetsAt: now + 3600 }] });
  expect(text()).toContain('limit reached · back');
  expect(colorOf('limit reached')).toBe('danger');

  render({ updatedAt: now, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: now + 3600 } });
  expect(text()).toContain(' · 840K of 1M today');
  expect(text()).not.toContain('$');
  render({ updatedAt: now, windows: [], free: { used: 10, limit: 1_000_000, resetsAt: now + 3600, paused: true } });
  expect(text()).toContain('paused · back');
  expect(text()).not.toContain('$');

  render({ updatedAt: now, windows: [], spend: { today: 9.75, week: 16.4, limit: 20, remaining: 3.6 } });
  expect(text()).toContain(' · $3.60 of $20 left');
  render({ updatedAt: now, windows: [], spend: { today: 11.2, week: 20, limit: 20, remaining: 0, rejected: true } });
  expect(text()).toContain(' · key limit reached');
  render({ updatedAt: now, windows: [], spend: { today: 4.12, week: 18.4 } });
  expect(text()).not.toContain(' · ');
});
