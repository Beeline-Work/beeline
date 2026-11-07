import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

vi.mock('react-native', () => ({ View: 'View', FlatList: 'FlatList', Platform: { OS: 'android' } }));
vi.mock('./chat-surface-styles', () => ({ styles: {} }));
vi.mock('@/buzz/activity-timeline', () => ({ buildTurnActivity: vi.fn() }));
vi.mock('@/components/buzz/ConversationComposer', () => ({ COMPOSER_MAX_INPUT_HEIGHT: 100, COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 40 }));
vi.mock('@/buzz/room-send-list', () => ({ RoomSendList: 'RoomSendList' }));
vi.mock('@/buzz/room-scroll-follow', () => ({ phoneTranscriptTailPadding: () => 40 }));
vi.mock('@/components/buzz/StarPromptCard', () => ({ StarPromptCard: () => null }));
vi.mock('@/components/buzz/RoomUnreadControls', () => ({ RoomUnreadControls: () => null }));
vi.mock('@/components/buzz/TranscriptScrubber', () => ({ TranscriptScrubber: () => null }));

import { ChatSurfaceTranscript } from './ChatSurfaceTranscript';

type Props = React.ComponentProps<typeof ChatSurfaceTranscript>;
let renderer: ReactTestRenderer;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

it('keeps a short-message viewport in the eager phone window through draft replacement and arrivals (R1)', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const row = (id: string): ChatDisplayMessage => ({ id, text: id, timestamp: 1, isUser: false });
  const history = Array.from({ length: 20 }, (_, n) => row(`earlier-${n}`));
  const props = {
    desktopTranscript: false, transcriptMessages: [row('draft'), ...history],
    scrollController: {}, phoneScrollList: {}, starPrompt: { prompt: null },
    renderItem: ({ item }: { item: ChatDisplayMessage }) => <React.Fragment>{item.text}</React.Fragment>,
  } as unknown as Props;
  act(() => { renderer = create(<ChatSurfaceTranscript {...props} />); });
  for (const messages of [props.transcriptMessages, [row('committed'), ...history], [row('next-draft'), row('committed'), ...history]]) {
    act(() => renderer.update(<ChatSurfaceTranscript {...props} transcriptMessages={messages} />));
    const list = renderer.root.findByType('RoomSendList');
    // RN retains the initial cells even when its moving window has not caught
    // up. Eight short 72dp rows fill this 576dp phone viewport without waiting
    // for another batch. Two eager rows leave three quarters of it unprotected.
    const eagerRows = list.props.data.slice(0, list.props.initialNumToRender);
    expect(eagerRows.length * 72).toBeGreaterThanOrEqual(576);
    expect(eagerRows.map((message: ChatDisplayMessage) => message.id)).toContain('earlier-5');
    expect(list.props.maxToRenderPerBatch).toBe(4);
    expect(list.props.windowSize).toBe(5);
    expect(list.props.maintainVisibleContentPosition.minIndexForVisible).toBe(1);
  }
});
