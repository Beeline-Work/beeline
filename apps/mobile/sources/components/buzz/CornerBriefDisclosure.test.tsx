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
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: { textPrimary: '#f0f0f3', textSecondary: '#c9c9d1' },
      }),
  },
}));
import { CornerBriefDisclosure } from './CornerBriefDisclosure';

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

describe('CornerBriefDisclosure', () => {
  it('opens the assigned revision, evidence, and file link from the corner', () => {
    const onOpenFile = vi.fn();
    const renderer = render(
      <CornerBriefDisclosure
        brief={{
          revision: 2,
          content: 'A1: keep all permission tiers.',
          attachments: [
            {
              title: 'matrix.md',
              purpose: 'approved permission matrix',
              required: true,
              url: 'https://server.example/v1/media/123',
            },
          ],
        }}
        validation={[{ stage: 'tests', status: 'pending', evidence: '' }]}
        onOpenFile={onOpenFile}
      />,
    );
    expect(renderer.root.findAllByProps({ testID: 'corner-brief-detail' })).toHaveLength(0);
    act(() => renderer.root.findByProps({ testID: 'corner-brief-toggle' }).props.onPress());
    expect(renderer.root.findByProps({ testID: 'corner-brief-detail' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'corner-validation' })).toBeDefined();
    const link = renderer.root
      .findAllByProps({ accessibilityRole: 'link' })
      .find((node: any) => node.type === 'Pressable');
    expect(link?.props.accessibilityLabel).toContain('approved permission matrix');
    act(() => link?.props.onPress());
    expect(onOpenFile).toHaveBeenCalledWith('https://server.example/v1/media/123');
  });
});
