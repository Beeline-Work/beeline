import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { RoomView, RoomViewMessage } from '@beeline/buzz-client';
import { transcriptBylineOpeners } from './message-dates';
import { type RoomMessageRenderer, useRoomMessageRenderItem } from './room-message-cell';
import {
  type ChatDisplayMessage,
  conversationIdentityByPubkey,
  createRoomMessageProjector,
  reconcileRoomMessageDelta,
} from './room-view-presentation';
import { observeTranscriptArrivals, EMPTY_TRANSCRIPT_ARRIVAL_STATE } from './transcript-motion';
import { sameRecordValueMap, sameStringSet, useStable } from './use-stable';

vi.mock('react-native', () => ({
  Text: (props: Record<string, unknown>) => React.createElement('Text', props),
  View: (props: Record<string, unknown>) => React.createElement('View', props),
}));

vi.mock('@/components/buzz/Ledger', () => ({
  withLedgerDayCaption: (node: unknown) => node,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = 'v'.repeat(64);
const AGENT = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Ruby' };
const PERSON = { pubkey: VIEWER, kind: 'human' as const, name: 'Owner' };

function message(index: number, author = index % 2 ? AGENT : PERSON): RoomViewMessage {
  return {
    id: index.toString(16).padStart(64, '0'),
    createdAt: 1_790_000_000 + index,
    text: `message ${index}`,
    presentation: 'message',
    author,
  };
}

function room(messages: RoomViewMessage[]): RoomView {
  return {
    room: { id: 'room', name: 'Room', workspaceId: 'workspace' },
    messages,
    members: [
      { identity: AGENT, role: 'member' },
      { identity: PERSON, role: 'owner' },
    ],
    latestAgentTurns: [],
    viewer: { identity: PERSON, role: 'owner', permissions: { manage: true } },
    repositoryResolution: { status: 'none' },
    watchFilters: [],
  } as unknown as RoomView;
}

/** FlatList re-invokes renderItem per cell; a PureComponent stands in for its cell. */
class Cell extends React.PureComponent<{
  item: ChatDisplayMessage;
  renderItem: ({ item }: { item: ChatDisplayMessage }) => React.ReactNode;
}> {
  override render() {
    return this.props.renderItem({ item: this.props.item });
  }
}

/**
 * The chat surface's row-renderer inputs, derived from one Room view the way
 * `_chat-surface.tsx` derives them. `stable` selects the fixed wiring.
 */
function Transcript({
  view,
  stable,
  onRow,
}: {
  view: RoomView;
  stable: boolean;
  onRow: (id: string) => void;
}) {
  const projector = React.useMemo(createRoomMessageProjector, []);
  const messages = React.useMemo(
    () => projector.project(view.messages, VIEWER),
    [projector, view.messages],
  );
  const rawIdentities = React.useMemo(
    () => conversationIdentityByPubkey(view.members, messages),
    [view.members, messages],
  );
  const stableIdentities = useStable(rawIdentities, sameRecordValueMap);
  const identities = stable ? stableIdentities : rawIdentities;
  const rawOpeners = React.useMemo(() => transcriptBylineOpeners(messages), [messages]);
  const stableOpeners = useStable(rawOpeners, sameStringSet);
  const bylineOpeners = stable ? stableOpeners : rawOpeners;
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  const replyDependency = stable ? null : messages;
  const beginReply = React.useCallback(
    () => messagesRef.current.length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replyDependency],
  );
  const arrivalRef = React.useRef(EMPTY_TRANSCRIPT_ARRIVAL_STATE);
  const arrival = React.useMemo(
    () =>
      observeTranscriptArrivals(arrivalRef.current, {
        surfaceId: 'room',
        hydrated: true,
        ids: messages.map((row) => row.id),
      }),
    [messages],
  );
  React.useEffect(() => {
    arrivalRef.current = arrival.state;
  }, [arrival.state]);
  const stableArriving = useStable(arrival.arrivingIds, sameStringSet);
  const render = React.useCallback<RoomMessageRenderer>(
    (item) => {
      onRow(item.id);
      return React.createElement('row', {
        id: item.id,
        author: item.pubkey ? identities.get(item.pubkey)?.name : undefined,
        opener: bylineOpeners.has(item.id),
        onReply: beginReply,
      });
    },
    [beginReply, bylineOpeners, identities, onRow],
  );
  const renderItem = useRoomMessageRenderItem({
    render,
    continuedIds: new Set(),
    precedingMessageById: new Map(),
    messageById: new Map(),
    arrivingCardIds: stable ? stableArriving : arrival.arrivingIds,
  });
  return React.createElement(
    React.Fragment,
    null,
    messages.map((item) => React.createElement(Cell, { key: item.id, item, renderItem })),
  );
}

function rowsPaintedForFinalMessage(stable: boolean) {
  const history = Array.from({ length: 20 }, (_, index) => message(index));
  const painted: string[] = [];
  const onRow = (id: string) => painted.push(id);
  let view = room(history);
  let renderer!: { update: (element: React.ReactElement) => void };
  act(() => {
    renderer = create(React.createElement(Transcript, { view, stable, onRow }));
  });
  painted.length = 0;
  const finalReply = message(21, AGENT);
  view = reconcileRoomMessageDelta(view, finalReply);
  act(() => {
    renderer.update(React.createElement(Transcript, { view, stable, onRow }));
  });
  return { painted: [...painted], finalId: finalReply.id };
}

describe('final agent message paint', () => {
  it('renders only the arriving row when the final reply delta lands', () => {
    const { painted, finalId } = rowsPaintedForFinalMessage(true);
    console.log(`[final-message-paint] fixed wiring rendered ${painted.length} row(s)`);
    expect(painted).toEqual([finalId]);
  });

  it('documents the old wiring, which re-rendered every resident row', () => {
    const { painted } = rowsPaintedForFinalMessage(false);
    console.log(`[final-message-paint] old wiring rendered ${painted.length} row(s)`);
    expect(painted).toHaveLength(21);
  });
});
