import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({
  parseInputs: [] as string[],
  reconciledSpans: [] as string[],
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    Platform: { OS: 'android' },
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
          accent: '#b08a4a',
          bgTexturePeak: '#333333',
          borderQuiet: '#444444',
          ledgerBright: '#f0f0f3',
          ledgerQuiet: '#90909b',
          monoRegular: 'IBMPlexMono-Regular',
          proseItalic: 'SpaceGrotesk-Italic',
          proseSemibold: 'SpaceGrotesk-SemiBold',
        },
      }),
  },
}));

vi.mock('@/components/buzz/CodeBlock', () => ({
  CodeBlock: (props: Record<string, unknown>) => React.createElement('CodeBlock', props, null),
}));

vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));

vi.mock('@/buzz/channel-reference', () => ({
  findChannelReferences: (text: string) => {
    probes.reconciledSpans.push(text);
    return [];
  },
}));

vi.mock('@/components/markdown/parseMarkdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/markdown/parseMarkdown')>();
  return {
    ...actual,
    parseMarkdown: (markdown: string) => {
      probes.parseInputs.push(markdown);
      return actual.parseMarkdown(markdown);
    },
    parseMarkdownWithOffsets: (markdown: string) => {
      probes.parseInputs.push(markdown);
      return actual.parseMarkdownWithOffsets(markdown);
    },
  };
});

import { MonoMarkdown } from './MonoMarkdown';

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

beforeEach(() => {
  probes.parseInputs.length = 0;
  probes.reconciledSpans.length = 0;
});

const channelIndex = { rooms: [], corners: [] };
const textStyle = { color: '#f0f0f3' };

function render(markdown: string): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(MonoMarkdown, {
        channelIndex,
        incremental: true,
        markdown,
        textStyle,
      }),
    );
  });
  return renderer;
}

describe('MonoMarkdown incremental streaming reconcile', () => {
  it('reparses and rebuilds only the mutable tail of a late cumulative commit', () => {
    const settledPrefix = Array.from({ length: 119 }, (_, index) => `Settled row ${index}`);
    const before = [...settledPrefix, 'Draft tail'].join('\n');
    const after = [...settledPrefix, 'Draft tail grows'].join('\n');
    const renderer = render(before);

    probes.parseInputs.length = 0;
    probes.reconciledSpans.length = 0;
    act(() => {
      renderer.update(
        React.createElement(MonoMarkdown, {
          channelIndex,
          incremental: true,
          markdown: after,
          textStyle,
        }),
      );
    });

    expect(probes.parseInputs).toEqual(['Draft tail grows']);
    expect(probes.reconciledSpans).toEqual(['Draft tail grows']);
  });
});
