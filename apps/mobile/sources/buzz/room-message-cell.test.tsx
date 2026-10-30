import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  archiveActionPresentation,
  liveCardPresentation,
  messageRosterPresentation,
  RoomMessageCell,
  type ArchiveActionInputs,
  type LiveCardInputs,
  type RoomMessageRenderContext,
  type RoomMessageRenderer,
  type RoomRosterSources,
  useRoomMessageRenderItem,
} from './room-message-cell';
import type { ChatDisplayMessage } from './room-view-presentation';
import { useTranscriptCardMotion } from '@/components/buzz/transcript-card-motion-context';

vi.mock('react-native', () => ({
  Text: (props: Record<string, unknown>) => React.createElement('Text', props),
  View: (props: Record<string, unknown>) => React.createElement('View', props),
}));

vi.mock('@/components/buzz/Ledger', () => ({
  withLedgerDayCaption: (node: unknown, label: string | null) =>
    label
      ? React.createElement('day-caption-wrap', { label }, node as React.ReactNode)
      : node,
}));

describe('RoomMessageCell', () => {
  it('updates card arrival context without rerendering unchanged message bodies', () => {
    const first: ChatDisplayMessage = { id: 'first', text: 'First', isUser: false, timestamp: 1 };
    const incoming: ChatDisplayMessage = { id: 'incoming', text: 'Incoming', isUser: false, timestamp: 2 };
    function CardMotionProbe() {
      const motion = useTranscriptCardMotion();
      return React.createElement('card-motion', { cardId: motion.cardId, arriving: motion.arriving });
    }
    const render = vi.fn<RoomMessageRenderer>(() => React.createElement(CardMotionProbe));
    function Harness({ rows, arriving }: { rows: ChatDisplayMessage[]; arriving: Set<string> }) {
      const renderItem = useRoomMessageRenderItem({
        render, arrivingCardIds: arriving, continuedIds: new Set(),
        precedingMessageById: new Map(), messageById: new Map(),
      });
      return React.createElement(React.Fragment, null,
        ...rows.map(item => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))),
      );
    }
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(React.createElement(Harness, { rows: [first], arriving: new Set(['first']) })); });
    render.mockClear();
    act(() => { renderer.update(React.createElement(Harness, { rows: [first, incoming], arriving: new Set(['incoming']) })); });
    expect(render.mock.calls.map(([item]) => item.id)).toEqual(['incoming']);
    expect(renderer.root.findAllByType('card-motion').map((node: { props: Record<string, unknown> }) => node.props))
      .toEqual([{ cardId: 'first', arriving: false }, { cardId: 'incoming', arriving: true }]);
    act(() => renderer.unmount());
  });

  it('isolates typing, arrivals, streaming, edits, reactions and per-row presentation', () => {
    const first: ChatDisplayMessage = { id: 'first', text: 'First', isUser: false, timestamp: 1 };
    const second: ChatDisplayMessage = { id: 'second', text: 'Second', isUser: false, timestamp: 2 };
    const third: ChatDisplayMessage = { id: 'third', text: 'Incoming', isUser: false, timestamp: 3 };
    const render = vi.fn<RoomMessageRenderer>((item, context) =>
      React.createElement('message-row', {
        id: item.id, text: item.text, reactions: item.reactions, ...context,
      }),
    );
    function Harness({ rows, hint }: { rows: ChatDisplayMessage[]; hint?: string }) {
      const renderItem = useRoomMessageRenderItem({
        render,
        continuedIds: new Set(),
        precedingMessageById: new Map(rows.slice(1).map((row, index) => [row.id, rows[index]!])),
        messageById: new Map(rows.map(row => [row.id, row])),
        // Typing recreates the list callback, but unchanged scalar row props
        // must survive the pure cell boundary.
        presentationForMessage: item => ({ untaggedHint: item.id === hint }),
      });
      return React.createElement(React.Fragment, null,
        ...rows.map(item => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))),
      );
    }
    let renderer!: ReactTestRenderer;
    const update = (rows: ChatDisplayMessage[], hint?: string) => {
      render.mockClear();
      act(() => {
        const node = React.createElement(Harness, { rows, hint });
        if (renderer) renderer.update(node);
        else renderer = create(node);
      });
      return render.mock.calls.map(([item]) => item.id);
    };
    expect(update([first, second])).toEqual(['first', 'second']);
    expect(update([first, second])).toEqual([]);
    expect(update([first, second, third])).toEqual(['third']);
    const streamed = { ...third, text: 'Incoming token' };
    expect(update([first, second, streamed])).toEqual(['third']);
    // Editing the second row also changes its successor's predecessor input.
    const edited = { ...second, text: 'Edited' };
    expect(update([first, edited, streamed])).toEqual(['second', 'third']);
    const reacted: ChatDisplayMessage = { ...streamed, reactions: [{ emoji: '👍', count: 1, reacted: true }] };
    expect(update([first, edited, reacted])).toEqual(['third']);
    expect(update([first, edited, reacted], 'first')).toEqual(['first']);
    expect(renderer.root.findByProps({ id: 'first' }).props.untaggedHint).toBe(true);
    expect(renderer.root.findByProps({ id: 'third' }).props.text).toBe('Incoming token');
    expect(renderer.root.findByProps({ id: 'third' }).props.reactions).toEqual(reacted.reactions);
    act(() => renderer.unmount());
  });

  it('does not rerender an identity-stable row when its parent list updates', () => {
    const message: ChatDisplayMessage = {
      id: 'message',
      text: 'Unchanged',
      isUser: false,
      timestamp: 1,
    };
    const render = vi.fn((item: ChatDisplayMessage) =>
      React.createElement('message-row', { text: item.text }),
    );
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, { item: message, render, continued: false }),
      );
    });
    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, { item: message, render, continued: false }),
      );
    });
    expect(render).toHaveBeenCalledTimes(1);

    const changedMessage = { ...message, text: 'Changed' };
    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: changedMessage,
          render,
          continued: false,
        }),
      );
    });
    expect(render).toHaveBeenCalledTimes(2);

    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: changedMessage,
          render,
          continued: true,
        }),
      );
    });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('CHEV-19: lays the arrival pointer under the row it landed on, and only that row', () => {
    const landed: ChatDisplayMessage = { id: 'msg-9', text: 'Target', isUser: false, timestamp: 1 };
    const render = vi.fn<RoomMessageRenderer>((item) =>
      React.createElement('message-row', { text: item.text }),
    );
    const grounds = (renderer: ReactTestRenderer) =>
      renderer.root.findAllByProps({ testID: 'arrival-flash-ground' }, { deep: false });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, {
          item: landed,
          render,
          continued: false,
          arrivalFlashing: false,
        }),
      );
    });
    expect(grounds(renderer)).toHaveLength(0);

    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: landed,
          render,
          continued: false,
          arrivalFlashing: true,
        }),
      );
    });
    expect(grounds(renderer)).toHaveLength(1);
    // The pointer is behind the row and out of the way: it must not consume a
    // touch meant for the message, nor be read out as content.
    expect(grounds(renderer)[0]!.props.pointerEvents).toBe('none');
    expect(grounds(renderer)[0]!.props.accessibilityElementsHidden).toBe(true);
    // And the row itself is unchanged by it: the pointer re-renders the cell
    // it rides, but renders the same message with the same context.
    expect(render.mock.calls[1]![0]).toBe(landed);
    expect(render.mock.calls[1]![1]).toEqual(render.mock.calls[0]![1]);
  });

  it('refreshes affected context through FlatList-compatible pure cell boundaries', () => {
    const message: ChatDisplayMessage = {
      id: 'message',
      text: 'Target',
      isUser: false,
      timestamp: 2,
    };
    const inserted: ChatDisplayMessage = {
      id: 'inserted',
      text: 'Late arrival',
      isUser: true,
      timestamp: 1,
    };
    const render = vi.fn<RoomMessageRenderer>((item, context) =>
      React.createElement('message-row', {
        text: item.text,
        precedingId: context.immediatelyPrecedingMessage?.id,
      }),
    );

    class FlatListCellBoundary extends React.PureComponent<{
      item: ChatDisplayMessage;
      renderItem: ({ item }: { item: ChatDisplayMessage }) => React.ReactNode;
    }> {
      override render() {
        return this.props.renderItem({ item: this.props.item });
      }
    }

    function Harness({
      precedingMessageById,
    }: {
      precedingMessageById: ReadonlyMap<string, ChatDisplayMessage>;
    }) {
      const renderItem = useRoomMessageRenderItem({
        render,
        continuedIds: new Set(),
        precedingMessageById,
        messageById: new Map(),
      });
      return React.createElement(FlatListCellBoundary, { item: message, renderItem });
    }

    const noPredecessor = new Map<string, ChatDisplayMessage>();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Harness, { precedingMessageById: noPredecessor }));
    });
    expect(renderer.root.findByType('message-row' as any).props.precedingId).toBeUndefined();

    act(() => {
      renderer.update(React.createElement(Harness, { precedingMessageById: noPredecessor }));
    });
    expect(render).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.update(
        React.createElement(Harness, {
          precedingMessageById: new Map([[message.id, inserted]]),
        }),
      );
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType('message-row' as any).props.precedingId).toBe(inserted.id);
  });

  it('hangs the day caption on the opener cell rather than inserting a list row', () => {
    const opener: ChatDisplayMessage = {
      id: 'opener',
      text: 'First of the day',
      isUser: true,
      timestamp: Math.floor(new Date(2026, 8, 17, 16, 58).getTime() / 1000),
    };
    const later: ChatDisplayMessage = {
      id: 'later',
      text: 'Same day',
      isUser: true,
      timestamp: Math.floor(new Date(2026, 8, 17, 17, 2).getTime() / 1000),
    };
    const render: RoomMessageRenderer = (item) =>
      React.createElement('message-row', { id: item.id });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, { item: opener, render, continued: false }),
      );
    });
    expect(renderer.root.findByType('day-caption-wrap' as any).props.label).toBe('THU 17 SEP');
    expect(renderer.root.findByType('message-row' as any).props.id).toBe('opener');

    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: later,
          render,
          continued: false,
          immediatelyPrecedingMessage: opener,
        }),
      );
    });
    expect(renderer.root.findAllByType('day-caption-wrap' as any)).toHaveLength(0);
    expect(renderer.root.findByType('message-row' as any).props.id).toBe('later');
  });

  it('places the first-new divider on the exact boundary row', () => {
    const message: ChatDisplayMessage = {
      id: 'host',
      text: 'New fact',
      isUser: false,
      timestamp: 1,
    };
    const render: RoomMessageRenderer = (item) =>
      React.createElement('message-row', { id: item.id });
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, {
          item: message,
          render,
          continued: false,
          startsNewMessages: true,
        }),
      );
    });

    expect(
      renderer.root.findAll(
        (node: { type: unknown; props: Record<string, unknown> }) =>
          node.type === 'View' && node.props.testID === 'new-messages-divider',
      ),
    ).toHaveLength(1);
    expect(renderer.root.findByType('message-row' as any).props.id).toBe('host');
  });

  it('does not render an unchanged row again when a fresh row arrives', () => {
    const kept: ChatDisplayMessage = { id: 'kept', text: 'Cached', isUser: false, timestamp: 1 };
    const arrived: ChatDisplayMessage = { id: 'fresh', text: 'Just arrived', isUser: true, timestamp: 2 };
    const counts = new Map<string, number>();
    function Harness({ rows }: { rows: ChatDisplayMessage[] }) {
      // A fresh Room payload recreates this function. Unchanged rows must ignore that.
      const render: RoomMessageRenderer = (item) => {
        counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
        return React.createElement('message-row', {
          id: item.id,
          text: item.text,
          deleted: item.deleted === true,
        });
      };
      const renderItem = useRoomMessageRenderItem({
        render,
        continuedIds: new Set(),
        precedingMessageById: new Map(rows.slice(1).map((row, index) => [row.id, rows[index]!])),
        messageById: new Map(rows.map((row) => [row.id, row])),
      });
      return React.createElement(React.Fragment, null,
        ...rows.map((item) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))),
      );
    }
    let renderer!: ReactTestRenderer;
    const show = (rows: ChatDisplayMessage[]) => {
      act(() => {
        const node = React.createElement(Harness, { rows });
        if (renderer) renderer.update(node);
        else renderer = create(node);
      });
    };
    show([kept]);
    expect(counts.get('kept')).toBe(1);
    show([kept, arrived]);
    expect(counts.get('kept')).toBe(1);
    expect(counts.get('fresh')).toBe(1);
    expect(renderer.root.findByProps({ id: 'kept' }).props.text).toBe('Cached');

    const edited = { ...arrived, text: 'Edited after it arrived' };
    show([kept, edited]);
    expect(counts.get('kept')).toBe(1);
    expect(counts.get('fresh')).toBe(2);
    expect(renderer.root.findByProps({ id: 'fresh' }).props.text).toBe('Edited after it arrived');

    const deleted = { ...kept, text: 'This message was deleted', deleted: true };
    show([deleted, edited]);
    expect(counts.get('kept')).toBe(2);
    expect(renderer.root.findByProps({ id: 'kept' }).props).toMatchObject({
      text: 'This message was deleted',
      deleted: true,
    });
    act(() => renderer.unmount());
  });

  it('re-renders approval loading and permission changes without painting an unchanged row', () => {
    const kept: ChatDisplayMessage = { id: 'kept', text: 'Cached', isUser: false, timestamp: 1 };
    const approval: ChatDisplayMessage = {
      id: 'approval',
      text: 'Allow this edit',
      isUser: false,
      timestamp: 2,
      writePermission: {
        permissionId: 'permission',
        requestId: 'request',
        agentPubkey: 'agent',
        requesterPubkey: 'requester',
        tool: 'edit_file',
        repository: 'owner/repo',
        status: 'pending',
      },
    };
    const owner = { pubkey: 'owner', kind: 'human' as const, name: 'Charles' };
    const grant: ChatDisplayMessage = {
      id: 'grant',
      text: 'Grant',
      isUser: false,
      timestamp: 3,
      grantRequest: {
        agent: { pubkey: 'agent', kind: 'agent', name: 'Terra' },
        owner,
        requester: owner,
        grants: [{
          grantId: 'g-1',
          kind: 'repository',
          target: 'owner/repo',
          reason: 'edit the repository',
          status: 'pending',
          requestedBy: owner,
          roomId: '22222222-2222-4222-8222-222222222222',
          createdAt: 1,
          auto: false,
        }],
      },
    };
    const counts = new Map<string, number>();
    const paint = (item: ChatDisplayMessage, context: RoomMessageRenderContext) => {
      counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      if (item.writePermission) {
        const busy = context.permissionActionId === item.writePermission.permissionId;
        if (context.canManageWorkspace !== true || context.viewerIsAgent === true) {
          return React.createElement('wait', { testID: 'corner-approval-audience-wait', id: item.id });
        }
        return React.createElement('button', {
          testID: 'write-permission-allow',
          id: item.id,
          accessibilityState: { disabled: busy, busy },
        });
      }
      if (item.grantRequest) {
        const grantId = item.grantRequest.grants[0]!.grantId;
        const busy = context.grantActionId === grantId;
        if (context.canManageWorkspace !== true) {
          return React.createElement('wait', { testID: 'grant-waiting', id: item.id });
        }
        return React.createElement('button', {
          testID: `grant-${grantId}-always`,
          id: item.id,
          accessibilityState: { disabled: context.grantActionId !== null, busy },
        });
      }
      return React.createElement('message-row', {
        id: item.id,
        text: item.text,
        deleted: item.deleted === true,
      });
    };
    function Harness({
      rows,
      permissionActionId,
      grantActionId,
      canManageWorkspace,
    }: {
      rows: ChatDisplayMessage[];
      permissionActionId: string | null;
      grantActionId: string | null;
      canManageWorkspace: boolean;
    }) {
      const inputs: LiveCardInputs = {
        permissionActionId,
        grantActionId,
        choiceActionId: null,
        connectorOfferActionId: null,
        appSignInActionId: null,
        targetBranchActionId: null,
        targetBranchNotice: null,
        canManageWorkspace,
        viewerIsAgent: false,
      };
      const renderItem = useRoomMessageRenderItem({
        render: paint,
        presentationForMessage: (item) => liveCardPresentation(item, inputs),
        continuedIds: new Set(),
        precedingMessageById: new Map(),
        messageById: new Map(rows.map((row) => [row.id, row])),
      });
      return React.createElement(React.Fragment, null,
        ...rows.map((item) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))),
      );
    }
    let renderer!: ReactTestRenderer;
    const show = (props: {
      rows: ChatDisplayMessage[];
      permissionActionId: string | null;
      grantActionId: string | null;
      canManageWorkspace: boolean;
    }) => {
      act(() => {
        const node = React.createElement(Harness, props);
        if (renderer) renderer.update(node);
        else renderer = create(node);
      });
    };
    const initial = {
      rows: [kept, approval, grant],
      permissionActionId: null,
      grantActionId: null,
      canManageWorkspace: true,
    };
    show(initial);
    expect(renderer.root.findByProps({ testID: 'write-permission-allow' }).props.accessibilityState)
      .toEqual({ disabled: false, busy: false });
    expect(renderer.root.findByProps({ testID: 'grant-g-1-always' }).props.accessibilityState)
      .toEqual({ disabled: false, busy: false });
    expect(counts.get('kept')).toBe(1);

    show({ ...initial, permissionActionId: 'permission' });
    expect(renderer.root.findByProps({ testID: 'write-permission-allow' }).props.accessibilityState)
      .toEqual({ disabled: true, busy: true });
    expect(counts.get('kept')).toBe(1);
    expect(counts.get('grant')).toBe(1);

    show({ ...initial, permissionActionId: 'permission', grantActionId: 'g-1' });
    expect(renderer.root.findByProps({ testID: 'grant-g-1-always' }).props.accessibilityState)
      .toEqual({ disabled: true, busy: true });
    expect(counts.get('kept')).toBe(1);
    expect(counts.get('approval')).toBe(2);

    show({ ...initial, permissionActionId: 'permission', grantActionId: 'g-1', canManageWorkspace: false });
    expect(renderer.root.findAllByProps({ testID: 'write-permission-allow' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'corner-approval-audience-wait' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'grant-waiting' })).toBeDefined();
    expect(counts.get('kept')).toBe(1);

    const edited = { ...kept, text: 'Edited after it arrived' };
    show({
      ...initial,
      rows: [edited, approval, grant],
      permissionActionId: 'permission',
      grantActionId: 'g-1',
      canManageWorkspace: false,
    });
    expect(counts.get('kept')).toBe(2);
    expect(renderer.root.findByProps({ id: 'kept' }).props.text).toBe('Edited after it arrived');
    expect(counts.get('approval')).toBe(3);

    const deleted = { ...edited, text: 'This message was deleted', deleted: true };
    show({
      ...initial,
      rows: [deleted, approval, grant],
      permissionActionId: 'permission',
      grantActionId: 'g-1',
      canManageWorkspace: false,
    });
    expect(counts.get('kept')).toBe(3);
    expect(renderer.root.findByProps({ id: 'kept' }).props).toMatchObject({
      text: 'This message was deleted',
      deleted: true,
    });
    act(() => renderer.unmount());
  });

  it('paints a hydrated name, avatar, and role without redrawing another row', () => {
    const kept: ChatDisplayMessage = {
      id: 'kept', text: 'Cached', isUser: false, timestamp: 1, pubkey: 'kept-person',
    };
    const speaker: ChatDisplayMessage = {
      id: 'speaker', text: 'Hello', isUser: false, timestamp: 2, pubkey: 'ada',
    };
    const counts = new Map<string, number>();
    const people = new Map<string, { name?: string; avatar?: string; face?: string }>([
      ['kept-person', { name: 'Kept', avatar: 'https://cdn.example/kept.png' }],
    ]);
    const roster = (extra?: Partial<RoomRosterSources>): RoomRosterSources => ({
      participantsHydrated: true,
      personByPubkey: people,
      agentByPubkey: new Map(),
      agentModelByPubkey: new Map(),
      roleByPubkey: new Map([['kept-person', 'member']]),
      participants: [
        { pubkey: 'ada', handle: 'ada' },
        { pubkey: 'kept-person', handle: 'kept' },
      ],
      ...extra,
    });
    const cached = roster();
    const hydrated = roster({
      personByPubkey: new Map([
        ['kept-person', { name: 'Kept', avatar: 'https://cdn.example/kept.png' }],
        ['ada', { name: 'Hydrated member', avatar: 'https://cdn.example/ada.png', face: 'fox' }],
      ]),
      agentModelByPubkey: new Map([['ada', 'Opus']]),
      roleByPubkey: new Map([['ada', 'owner'], ['kept-person', 'member']]),
      participants: [
        { pubkey: 'ada', handle: 'hydrated' },
        { pubkey: 'kept-person', handle: 'kept' },
      ],
    });
    expect(messageRosterPresentation(kept, hydrated)).toEqual(messageRosterPresentation(kept, cached));

    function Harness({ sources }: { sources: RoomRosterSources }) {
      const render: RoomMessageRenderer = (item, context) => {
        counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
        return React.createElement('message-row', {
          id: item.id,
          name: context.personName ?? context.agentName ?? 'Unknown',
          avatar: context.personAvatar ?? context.agentAvatar ?? '',
          role: context.speakerRole ?? '',
          model: context.agentModel ?? '',
        });
      };
      const renderItem = useRoomMessageRenderItem({
        render,
        presentationForMessage: (item) => messageRosterPresentation(item, sources),
        continuedIds: new Set(),
        precedingMessageById: new Map(),
        messageById: new Map([kept, speaker].map((row) => [row.id, row])),
      });
      return React.createElement(React.Fragment, null,
        ...[kept, speaker].map((item) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))),
      );
    }
    let renderer!: ReactTestRenderer;
    const show = (sources: RoomRosterSources) => {
      act(() => {
        const node = React.createElement(Harness, { sources });
        if (renderer) renderer.update(node);
        else renderer = create(node);
      });
    };
    show(cached);
    expect(renderer.root.findByProps({ id: 'speaker' }).props).toMatchObject({
      name: 'Unknown', avatar: '', role: '', model: '',
    });
    expect(counts.get('kept')).toBe(1);
    expect(counts.get('speaker')).toBe(1);

    show(hydrated);
    expect(renderer.root.findByProps({ id: 'speaker' }).props).toMatchObject({
      name: 'Hydrated member',
      avatar: 'https://cdn.example/ada.png',
      role: 'owner',
      model: 'Opus',
    });
    expect(counts.get('speaker')).toBe(2);
    expect(counts.get('kept')).toBe(1);
    expect(renderer.root.findByProps({ id: 'kept' }).props).toMatchObject({
      name: 'Kept', avatar: 'https://cdn.example/kept.png', role: 'member',
    });
    act(() => renderer.unmount());
  });

  it('turns proposal choices and corner swipe off when a cached Room is archived', () => {
    const kept: ChatDisplayMessage = {
      id: 'kept',
      text: 'Allow this edit',
      isUser: false,
      timestamp: 1,
      writePermission: {
        permissionId: 'permission',
        requestId: 'request',
        agentPubkey: 'agent',
        requesterPubkey: 'requester',
        tool: 'edit_file',
        status: 'pending',
      },
    };
    const proposal: ChatDisplayMessage = {
      id: 'proposal',
      text: 'Proposed corner: Faster reads — Bound query latency under load',
      isUser: false,
      timestamp: 2,
      isAgentAuthor: true,
    };
    const swipe: ChatDisplayMessage = {
      id: 'swipe', text: 'Move this work', isUser: false, timestamp: 3,
    };
    const rows = [kept, proposal, swipe];
    const counts = new Map<string, number>();
    const open: ArchiveActionInputs = {
      roomArchived: false,
      cornerSwipeOffered: true,
      cornerProposalOffered: true,
    };
    expect(archiveActionPresentation(kept, open)).toEqual({});
    expect(archiveActionPresentation(swipe, open)).toEqual({
      roomArchived: false,
      cornerSwipeEnabled: true,
    });
    expect(archiveActionPresentation(proposal, open)).toEqual({
      roomArchived: false,
      cornerSwipeEnabled: true,
      cornerProposalEnabled: true,
    });
    expect(archiveActionPresentation(swipe, { ...open, cornerSwipeOffered: false })).toEqual({});

    function Harness({ archived }: { archived: boolean }) {
      const inputs: ArchiveActionInputs = { ...open, roomArchived: archived };
      const render: RoomMessageRenderer = (item, context) => {
        counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
        return React.createElement('message-row', {
          id: item.id,
          proposal: context.cornerProposalEnabled === true,
          swipe: context.cornerSwipeEnabled === true,
          archived: context.roomArchived === true,
        });
      };
      const renderItem = useRoomMessageRenderItem({
        render,
        presentationForMessage: (item) => archiveActionPresentation(item, inputs),
        continuedIds: new Set(),
        precedingMessageById: new Map(),
        messageById: new Map(rows.map((row) => [row.id, row])),
      });
      return React.createElement(React.Fragment, null,
        ...rows.map((item) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))),
      );
    }
    let renderer!: ReactTestRenderer;
    const show = (archived: boolean) => {
      act(() => {
        const node = React.createElement(Harness, { archived });
        if (renderer) renderer.update(node);
        else renderer = create(node);
      });
    };
    show(false);
    expect(renderer.root.findByProps({ id: 'proposal' }).props).toMatchObject({
      proposal: true, swipe: true, archived: false,
    });
    expect(renderer.root.findByProps({ id: 'swipe' }).props).toMatchObject({
      proposal: false, swipe: true, archived: false,
    });
    expect(counts.get('kept')).toBe(1);

    show(true);
    expect(renderer.root.findByProps({ id: 'proposal' }).props).toMatchObject({
      proposal: false, swipe: false, archived: true,
    });
    expect(renderer.root.findByProps({ id: 'swipe' }).props).toMatchObject({
      proposal: false, swipe: false, archived: true,
    });
    expect(counts.get('kept')).toBe(1);
    expect(counts.get('proposal')).toBe(2);
    expect(counts.get('swipe')).toBe(2);
    act(() => renderer.unmount());
  });
});
