import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android' },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
  };
});

import { StreamingAgentText } from './StreamingAgentText';
import type { SessionEvent } from '@/sync/transport';

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

function draftEvent(text: string, requestId: string): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'channel-1',
    payload: {
      id: `draft-${text.length}`,
      content: text,
      pubkey: 'a'.repeat(64),
      createdAt: 1,
      tags: [
        ['h', 'channel-1'],
        ['t', 'agent-draft'],
        ['agent', 'a'.repeat(64)],
        ['session', 'session-1'],
        ['request', requestId],
      ],
    },
  };
}

function displayedText(node: ReactTestRenderer): string {
  const matches = node.root.findAllByProps({ testID: 'streaming-agent-text' });
  return matches.length ? (matches[0]!.props.children as string) : '';
}

describe('StreamingAgentText', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reveals only the matching turn\'s draft text, ignoring other requests', async () => {
    let handler: ((event: SessionEvent) => void) | undefined;
    const stop = vi.fn();
    const transport = {
      agentDraftSubscribeReady: vi.fn(async (_channelId: string, h: (event: SessionEvent) => void) => {
        handler = h;
        return stop;
      }),
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(StreamingAgentText, {
          transport: transport as never,
          channelId: 'channel-1',
          requestId: 'request-1',
        }),
      );
      await Promise.resolve();
    });

    expect(transport.agentDraftSubscribeReady).toHaveBeenCalledWith(
      'channel-1',
      expect.any(Function),
    );

    // Draft for a different in-flight request must never leak in.
    await act(async () => {
      handler?.(draftEvent('wrong turn', 'request-other'));
    });
    expect(displayedText(renderer)).toBe('');

    await act(async () => {
      handler?.(draftEvent('Hello world', 'request-1'));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(displayedText(renderer)).toBe('Hello world');

    act(() => {
      renderer.unmount();
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('renders nothing when the harness never streams a chunk (graceful degradation)', async () => {
    const transport = {
      agentDraftSubscribeReady: vi.fn(async () => vi.fn()),
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(StreamingAgentText, {
          transport: transport as never,
          channelId: 'channel-1',
          requestId: 'request-1',
        }),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(displayedText(renderer)).toBe('');
  });
});
