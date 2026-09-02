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
      factory({
        buzz: {
          accent: '#gold',
          border: '#border',
          danger: '#danger',
          ledgerGhost: '#ghost',
          ledgerQuiet: '#quiet',
          textMuted: '#muted',
        },
      }),
  },
}));
vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return { MonoButton: (props: any) => ReactModule.createElement('MonoButton', props) };
});

import { CornerLifecyclePanel } from './CornerLifecyclePanel';

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
  checks: 'passing' as const,
  branch: 'fm/fix',
  pr: {
    number: 42,
    url: 'https://github.com/acme/beeline/pull/42',
    title: 'Fix the corner lifecycle',
    targetBranch: 'main',
    headSha: 'a'.repeat(40),
  },
  checksSummary: {
    status: 'passing' as const,
    total: 2,
    failing: [],
    checks: [
      { name: 'mobile typecheck', status: 'passed' as const, conclusion: 'success' },
      { name: 'mobile tests', status: 'passed' as const, conclusion: 'success' },
    ],
    updatedAt: 1,
  },
};

describe('CornerLifecyclePanel', () => {
  it('keeps the PR and test result visible and lets managers approve', () => {
    const open = vi.fn();
    const approve = vi.fn();
    const renderer = render(
      <CornerLifecyclePanel
        lifecycle={lifecycle}
        archived={false}
        canApprove
        onOpenPullRequest={open}
        onApprove={approve}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'corner-test-result' }).props.children).toBe(
      'TESTS PASSED',
    );
    expect(
      renderer.root.findByProps({ testID: 'corner-check-mobile tests' }).props.children,
    ).toEqual(['✓', ' ', 'mobile tests', ' · success']);
    act(() => renderer.root.findByProps({ testID: 'corner-pull-request-link' }).props.onPress());
    expect(open).toHaveBeenCalledWith(lifecycle.pr.url);
    act(() => renderer.root.findByProps({ testID: 'approve-corner-merge' }).props.onPress());
    expect(approve).toHaveBeenCalledWith(false);
  });

  it('renders an archived corner read-only with its approval result', () => {
    const renderer = render(
      <CornerLifecyclePanel
        lifecycle={{ ...lifecycle, lifecycle: 'done', outcome: 'landed' }}
        archived
        canApprove
        approvalResult="Merge approved."
        onOpenPullRequest={() => undefined}
        onApprove={() => undefined}
      />,
    );
    expect(renderer.root.findAllByProps({ testID: 'approve-corner-merge' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'corner-merge-result' }).props.children).toBe(
      'Merge approved.',
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('LANDED · READ-ONLY');
  });

  it('does not expose approval to ordinary members', () => {
    const renderer = render(
      <CornerLifecyclePanel
        lifecycle={{
          ...lifecycle,
          checks: 'failing',
          checksSummary: {
            ...lifecycle.checksSummary,
            status: 'failing',
            failing: ['mobile tests'],
            checks: [{ name: 'mobile tests', status: 'failed', conclusion: 'failure' }],
          },
        }}
        archived={false}
        canApprove={false}
        onOpenPullRequest={() => undefined}
        onApprove={() => undefined}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'corner-test-result' }).props.children).toBe(
      'TESTS FAILED',
    );
    expect(renderer.root.findAllByProps({ testID: 'approve-corner-merge' })).toHaveLength(0);
  });

  it('makes a manager explicitly approve anyway when named checks are failing', () => {
    const approve = vi.fn();
    const failing = {
      ...lifecycle,
      checks: 'failing' as const,
      checksSummary: {
        ...lifecycle.checksSummary,
        status: 'failing' as const,
        failing: ['mobile tests'],
        checks: [{ name: 'mobile tests', status: 'failed' as const, conclusion: 'failure' }],
      },
    };
    const renderer = render(
      <CornerLifecyclePanel
        lifecycle={failing}
        archived={false}
        canApprove
        onOpenPullRequest={() => undefined}
        onApprove={approve}
      />,
    );
    const button = renderer.root.findByProps({ testID: 'approve-corner-merge' });
    expect(button.props.label).toBe('APPROVE ANYWAY');
    act(() => button.props.onPress());
    expect(approve).toHaveBeenCalledWith(true);
  });
});
