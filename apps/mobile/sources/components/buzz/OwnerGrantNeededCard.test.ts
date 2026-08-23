import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const shareSpy = vi.fn(() => Promise.resolve({ action: 'sharedAction' }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  return {
    Share: { share: (...args: unknown[]) => shareSpy(...args) },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  useUnistyles: () => ({
    theme: {
      buzz: {
        accent: '#b08a4a',
        textPrimary: '#fff',
        textSecondary: '#ccc',
        dim: '#666',
      },
    },
  }),
}));

import {
  OWNER_GRANT_COPY,
  OWNER_GRANT_SHARE_LABEL,
  OWNER_GRANT_TITLE,
  OwnerGrantNeededCard,
  ownerGrantShareMessage,
} from './OwnerGrantNeededCard';

// The component imports Typography for its style sheet; the mocked
// react-native above has no Platform, so stub the module before import.
vi.mock('@/constants/Typography', () => ({
  Typography: {
    mono: () => ({ fontFamily: 'mono' }),
    default: () => ({ fontFamily: 'default' }),
  },
}));

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

/** Flattened text of every Text node, in render order. */
function texts(renderer: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestRenderer['root']): void => {
    for (const child of node.children) {
      if (typeof child === 'string') out.push(child);
      else walk(child as never);
    }
  };
  renderer.root.findAll(() => true).forEach((node) => {
    if (node.props.testID === undefined && typeof node.type === 'string' && node.type === 'Text') {
      walk(node);
    }
  });
  // Fallback: collect every string in tree order.
  if (out.length === 0) {
    const collect = (node: any): void => {
      for (const child of node.children ?? []) {
        if (typeof child === 'string') out.push(child);
        else collect(child);
      }
    };
    collect(renderer.root);
  }
  return out;
}

const GRANT = {
  repository: 'bananaman614305/widget',
  installUrl: 'https://github.com/apps/beeline/installations/new',
};

describe('OwnerGrantNeededCard', () => {
  it('renders the typed pending state with the pinned copy and the install link', () => {
    const renderer = render(React.createElement(OwnerGrantNeededCard, GRANT));
    const rendered = texts(renderer).join('\n');
    expect(rendered).toContain(OWNER_GRANT_TITLE);
    expect(rendered).toContain(OWNER_GRANT_COPY);
    expect(rendered).toContain(OWNER_GRANT_SHARE_LABEL);
    expect(renderer.root.findByProps({ testID: 'owner-grant-url' }).props.children).toBe(
      GRANT.installUrl,
    );
    expect(renderer.root.findByProps({ testID: 'owner-grant-card' })).toBeDefined();
  });

  it('shares the link through the system share sheet on press', () => {
    const renderer = render(React.createElement(OwnerGrantNeededCard, GRANT));
    act(() => {
      renderer.root.findByProps({ testID: 'owner-grant-share' }).props.onPress();
    });
    expect(shareSpy).toHaveBeenCalledWith({
      message: ownerGrantShareMessage(GRANT),
    });
  });

  it('builds a share message that names the repository and carries the URL verbatim', () => {
    const message = ownerGrantShareMessage(GRANT);
    expect(message).toContain(OWNER_GRANT_COPY);
    expect(message).toContain(GRANT.installUrl);
    expect(message).toContain(GRANT.repository);
  });
});
