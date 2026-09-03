import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) =>
      factory({ buzz: { accent: '#gold', ledgerQuiet: '#quiet' } }),
  },
}));

import { CornerStatusLine } from './CornerStatusLine';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const lifecycle = {
  lifecycle: 'in-review' as const,
  checks: 'pending' as const,
  pr: {
    number: 840,
    url: 'https://github.com/acme/beeline/pull/840',
    title: 'Fix pairing expiry',
    targetBranch: 'main',
    headSha: 'a'.repeat(40),
  },
  checksSummary: {
    status: 'pending' as const,
    total: 15,
    failing: [],
    checks: [
      { name: 'MOBILE SUITE', status: 'passed' as const, conclusion: 'success' },
      { name: 'BODY SUITE', status: 'pending' as const },
    ],
    updatedAt: 1,
  },
};

describe('CornerStatusLine', () => {
  it('is one inscribed link with the ↗ affordance and no button', () => {
    const onOpenPullRequest = vi.fn();
    const renderer = render(
      <CornerStatusLine archived={false} lifecycle={lifecycle} onOpenPullRequest={onOpenPullRequest} />,
    );
    // findAllByProps also matches the memo wrapper; count host elements only.
    const pressables = renderer.root.findAllByType('Pressable' as any);
    expect(pressables).toHaveLength(1);
    expect(pressables[0].props.accessibilityRole).toBe('link');
    expect(
      renderer.root
        .findAllByProps({ accessibilityRole: 'button' })
        .filter((node: any) => typeof node.type === 'string'),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType('MonoButton' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('View' as any)).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'corner-status-copy' }).props.children).toBe(
      'PR #840 · 1/15 tests passed · running',
    );
    expect(renderer.root.findByProps({ testID: 'corner-status-affordance' }).props.children).toBe(
      '↗',
    );
    act(() => renderer.root.findByProps({ testID: 'corner-status-line' }).props.onPress());
    expect(onOpenPullRequest).toHaveBeenCalledWith('https://github.com/acme/beeline/pull/840');
  });

  it('renders nothing before a pull request exists', () => {
    expect(
      render(
        <CornerStatusLine
          archived={false}
          lifecycle={{ lifecycle: 'working', checks: 'unknown' }}
          onOpenPullRequest={() => undefined}
        />,
      ).toJSON(),
    ).toBeNull();
    expect(
      render(<CornerStatusLine archived onOpenPullRequest={() => undefined} />).toJSON(),
    ).toBeNull();
  });
});
