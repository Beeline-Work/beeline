import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { groknight } from '@/buzz/groknight';
import {
  ROOM_OPEN_LIST_TAIL_PADDING,
  roomOpenBottomChromeHeight,
  roomOpenNewestTextMetrics,
} from '@/buzz/room-open-geometry';
import { AgentOfflineHint } from '@/components/buzz/AgentOfflineHint';
import { RoomOpenPixel } from './_room-open-pixel';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android' },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', async () => {
  const { groknight: tokens } = await import('@/buzz/groknight');
  const buzz = {
    agentOfflineHintTypography: tokens.agentOfflineHintTypography,
    bgBase: '#000',
    bgTerminal: '#000',
    borderStrong: '#555',
    textMuted: '#aaa',
    textPrimary: '#fff',
  };
  return {
    StyleSheet: {
      create: (factory: (theme: { buzz: typeof buzz }) => unknown) => factory({ buzz }),
    },
    useUnistyles: () => ({ theme: { buzz } }),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 48, left: 0 }),
}));

vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return { SurfaceGlyphLoader: (props: any) => ReactModule.createElement('Loader', props) };
});

type Style = Record<string, number | string | undefined>;

function flattened(
  style: Style | readonly (Style | false | null | undefined)[] | undefined,
): Style {
  if (!Array.isArray(style)) return (style ?? {}) as Style;
  return Object.assign({}, ...style.filter(Boolean).map((item) => flattened(item as Style)));
}

function verticalOuterHeight(node: ReactTestInstance): number {
  const style = flattened(node.props.style);
  const margin =
    Number(style.marginTop ?? style.marginVertical ?? 0) +
    Number(style.marginBottom ?? style.marginVertical ?? 0);
  if (node.type === 'Text') return margin + Number(style.lineHeight ?? style.fontSize ?? 0);
  const padding =
    Number(style.paddingTop ?? style.paddingVertical ?? 0) +
    Number(style.paddingBottom ?? style.paddingVertical ?? 0);
  const border =
    Number(style.borderTopWidth ?? style.borderWidth ?? 0) +
    Number(style.borderBottomWidth ?? style.borderWidth ?? 0);
  const children = (node.children as Array<string | ReactTestInstance>)
    .filter(
      (child: string | ReactTestInstance): child is ReactTestInstance => typeof child !== 'string',
    )
    .reduce((height: number, child: ReactTestInstance) => height + verticalOuterHeight(child), 0);
  return (
    margin +
    Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0), padding + border + children)
  );
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

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

describe('Room-open thin/full handoff geometry', () => {
  it('keeps the extracted offline typography metrics identical to the prior inline footer', () => {
    const full = render(<AgentOfflineHint />);
    const [title, text] = full.root.findAllByType('Text');

    expect(flattened(title.props.style)).toMatchObject({
      fontFamily: 'IBMPlexMono-SemiBold',
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.55,
    });
    expect(flattened(text.props.style)).toMatchObject({
      fontFamily: 'IBMPlexSans-Regular',
      fontSize: 11,
      lineHeight: 15,
    });
  });

  it('keeps the newest row at the same fixed-viewport y when full chrome reveals AGENT OFFLINE', () => {
    const thin = render(
      <RoomOpenPixel
        roomSurface={null}
        seedText="PIXEL-450 NEWEST ROW — chat opened at the end"
        agentsOffline
        onFirstPaint={() => undefined}
      />,
    );
    const full = render(<AgentOfflineHint />);
    const thinOffline = thin.root.findAll(
      (node: ReactTestInstance) =>
        node.type === 'View' && node.props.testID === 'room-open-pixel-offline-reserve',
    )[0];
    const fullOffline = full.root.find(
      (node: ReactTestInstance) =>
        node.type === 'View' && node.props.testID === 'agent-offline-hint',
    );
    const thinList = thin.root.find(
      (node: ReactTestInstance) =>
        node.type === 'View' && node.props.testID === 'room-open-pixel-list-reserve',
    );
    const viewportPx = 2_400;
    const density = 2.625;
    const newestLineCount = 2;
    const baseBottom = roomOpenBottomChromeHeight('android', 48);
    const newestHeight = newestLineCount * roomOpenNewestTextMetrics().lineHeight;
    const thinOfflineHeight = thinOffline ? verticalOuterHeight(thinOffline) : 0;
    const fullOfflineHeight = verticalOuterHeight(fullOffline);
    const thinListPaddingBottom = Number(flattened(thinList.props.style).paddingBottom ?? 0);
    const composerAndInsetHeight = baseBottom - thinListPaddingBottom;
    const fullBylinedListPaddingBottom =
      ROOM_OPEN_LIST_TAIL_PADDING + groknight.messagePaddingVertical * 3;
    const thinNewestY =
      viewportPx -
      (composerAndInsetHeight + thinListPaddingBottom + thinOfflineHeight + newestHeight) * density;
    const fullNewestY =
      viewportPx -
      (composerAndInsetHeight + fullBylinedListPaddingBottom + fullOfflineHeight + newestHeight) *
        density;

    expect(thinOfflineHeight).toBe(fullOfflineHeight);
    expect(thinListPaddingBottom).toBe(fullBylinedListPaddingBottom);
    expect(Math.abs(thinNewestY - fullNewestY)).toBeLessThanOrEqual(1);
  });
});
