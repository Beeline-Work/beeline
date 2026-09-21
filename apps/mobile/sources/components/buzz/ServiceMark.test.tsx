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
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

import { ServiceMark, serviceFaviconUrl } from './ServiceMark';

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

describe('ServiceMark', () => {
  it('renders the lettermark alone when the server reports no favicon domain', () => {
    const renderer = render(<ServiceMark company="resend" testID="mark" />);
    expect(renderer.root.findByProps({ testID: 'mark' })).toBeTruthy();
    expect(renderer.root.findByType('Text').props.children).toBe('R');
    expect(renderer.root.findAllByType('Image')).toHaveLength(0);
  });

  it('fetches Google favicon service at the server-derived domain, lettermark behind it', () => {
    const renderer = render(<ServiceMark company="resend" domain="resend.com" testID="mark" />);
    const image = renderer.root.findByType('Image');
    expect(image.props.source).toEqual({ uri: serviceFaviconUrl('resend.com') });
    expect(image.props.source.uri).toBe(
      'https://www.google.com/s2/favicons?domain=resend.com&sz=64',
    );
    // The lettermark is still painted, so a 404/offline image reveals it.
    expect(renderer.root.findByType('Text').props.children).toBe('R');
  });

  it('drops the image on error, leaving the lettermark to read', () => {
    const renderer = render(<ServiceMark company="sentry" domain="sentry.io" testID="mark" />);
    act(() => {
      renderer.root.findByType('Image').props.onError();
    });
    expect(renderer.root.findAllByType('Image')).toHaveLength(0);
    expect(renderer.root.findByType('Text').props.children).toBe('S');
  });
});
