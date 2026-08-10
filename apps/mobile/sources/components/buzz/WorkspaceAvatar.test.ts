import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Image: host('Image'),
    StyleSheet: { create: (styles: unknown) => styles },
    View: host('View'),
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Polygon: host('Polygon') };
});

import { WorkspaceAvatar } from './WorkspaceAvatar';

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

describe('Workspace avatar', () => {
  const community = {
    communityId: '11111111-1111-4111-8111-111111111111',
    name: 'Personal',
  } as any;

  it('renders the relay avatar when one is assigned and falls back after an image error', () => {
    const renderer = render(
      React.createElement(WorkspaceAvatar, {
        community: { ...community, avatar: 'https://example.test/personal.png' },
      }),
    );

    const image = renderer.root.findByType('Image' as any);
    expect(image.props.source).toEqual({ uri: 'https://example.test/personal.png' });
    act(() => image.props.onError());
    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('Polygon' as any).length).toBeGreaterThan(0);
  });

  it('renders a geometric mark instead of acronym text when no avatar is assigned', () => {
    const renderer = render(React.createElement(WorkspaceAvatar, { community }));
    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('Polygon' as any).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType('Text' as any)).toHaveLength(0);
  });
});
