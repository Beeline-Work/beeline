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
  return { default: host('Svg'), G: host('G'), Polygon: host('Polygon') };
});

import { AgentAvatar } from './AgentAvatar';

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

describe('Agent avatar', () => {
  const pubkey = '2222222222222222222222222222222222222222222222222222222222222222';

  it('renders the faceted mark, not the image, when a kind:0 picture is assigned', () => {
    const renderer = render(
      React.createElement(AgentAvatar, {
        pubkey,
        avatarUrl: 'https://example.test/joy.png',
        name: 'Joy',
      }),
    );

    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('Polygon' as any).length).toBeGreaterThan(0);
  });

  it('renders a faceted mark when no picture is assigned', () => {
    const renderer = render(React.createElement(AgentAvatar, { pubkey, name: 'Joy' }));
    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('Polygon' as any).length).toBeGreaterThan(0);
  });
});
