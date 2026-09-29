import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (styles: any) => styles({ buzz: { type: { meta: {} } } }),
    hairlineWidth: 1,
  },
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View'), Pressable: host('Pressable') };
});
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Icon', props) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

import { AgentTagChips, agentTierSource } from './AgentTagChips';

const tags = [
  { tag: 'heavy', kind: 'tier' as const, removable: false },
  { tag: 'opus', kind: 'family' as const, removable: false },
  { tag: 'claude-code', kind: 'harness' as const, removable: false },
  { tag: 'anthropic', kind: 'provider' as const, removable: false },
  { tag: 'reviewer', kind: 'custom' as const, removable: true },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => vi.restoreAllMocks());

function render(onRemove?: (tag: string) => void) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<AgentTagChips onRemove={onRemove} tags={tags} />);
  });
  return renderer;
}

describe('AgentTagChips', () => {
  it('locks automatic tags and never offers to remove them', () => {
    const onRemove = vi.fn();
    const renderer = render(onRemove);
    for (const tag of ['heavy', 'opus', 'claude-code', 'anthropic']) {
      expect(renderer.root.findAllByProps({ testID: `agent-tag-lock-${tag}` }).length).toBeGreaterThan(0);
      expect(renderer.root.findAllByProps({ testID: `agent-tag-remove-${tag}` })).toHaveLength(0);
    }
    act(() => renderer.root.findByProps({ testID: 'agent-tag-remove-reviewer' }).props.onPress());
    expect(onRemove).toHaveBeenCalledWith('reviewer');
  });

  it('shows custom tags without a remove control on the profile', () => {
    const renderer = render();
    expect(renderer.root.findAllByProps({ testID: 'agent-tag-reviewer' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-tag-remove-reviewer' })).toHaveLength(0);
  });

  it('says where the tier came from', () => {
    expect(
      agentTierSource({ tags, tier: 'heavy', unclassified: false, source: 'price', outputCost: 20 }),
    ).toBe('Tier from models.dev: $20 per 1M output tokens');
    expect(
      agentTierSource({ tags, tier: 'light', unclassified: false, source: 'price', outputCost: 0.6 }),
    ).toBe('Tier from models.dev: $0.60 per 1M output tokens');
    expect(
      agentTierSource({ tags, tier: 'light', unclassified: true, source: 'unlisted' }),
    ).toMatch(/does not list this model yet/);
  });
});
