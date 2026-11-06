import { layout, appState, navigation, route, workspaceSet, phoneOperation, liveRegistrations, roomRead, prefetchRoom, theme, safeArea, applyNeedsYouLiveDelta, person, bookmark, need, serve, returnToForeground, textOf, mountedTrees, renderTray, fixtureScope1, fixtureScope7 } from "../../../test/fixtures/tray.test-support";
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import TrayScreen from './tray';
import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
import * as needFormatting from '@/buzz/needs-you';
import { useNeedsYouCount, useTrayList, holdNeedsYou, acknowledgePaintedNeedsYou } from '@/buzz/needs-you-store';
import { mobileSurfaceCache } from '@/buzz/surface-storage';



it('renders only the changed Needs-you cell when a projection replaces unchanged DTOs', () => {
  const render = vi.spyOn(needFormatting, 'needsYouExpiryLabel');
  const action = () => undefined;
  const items = [need({ messageId: 'a' }), need({ messageId: 'b' })];
  const cells = (values: typeof items) => (
    <>
      {values.map((item) => (
        <NeedsYouCell
          key={item.messageId}
          item={item}
          now={1_700_000_000_000}
          desktop={false}
          onOpen={action}
          onDismiss={action}
        />
      ))}
    </>
  );
  let tree: ReactTestRenderer | undefined;
  try {
    act(() => {
      tree = create(cells(items));
    });
    render.mockClear();
    const next = structuredClone(items);
    next[0] = { ...next[0]!, text: 'A changed question' };
    act(() => tree!.update(cells(next)));
    expect(render).toHaveBeenCalledOnce();
  } finally {
    act(() => tree?.unmount());
    render.mockRestore();
  }
});
describe.each([
  { surface: 'desktop', os: 'web', width: 1200, remove: true },
  { surface: 'mobile', os: 'ios', width: 390, remove: false },
  { surface: 'R12a compact web', os: 'web', width: 760, remove: false },
])('Bookmarks $surface rows', ({ os, width, remove }) => {
const scope1 = fixtureScope1({ os, width, remove });


  it('Reproduction R1: reads like a Needs you cell: who and age, the quoted words, then where', async () => {
    layout.os = os;
    layout.width = width;
    const now = 1_700_010_000_000;
    const nowSeconds = now / 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    serve({
      bookmarks: [
        bookmark({
          messageCreatedAt: nowSeconds - 7200,
          bookmarkedAt: nowSeconds - 120,
          text: 'Attached **Inscriptions—ancient signs, personal color.**\n\n**Unclosed',
        }),
        bookmark({
          messageId: 'gone',
          messageCreatedAt: nowSeconds - 86400,
          bookmarkedAt: nowSeconds - 3600,
          available: false,
          text: undefined,
          author: undefined,
        }),
        bookmark({ messageId: 'nowhere', roomName: '', bookmarkedAt: nowSeconds - 60 }),
      ],
    });
    try {
      const tree = await renderTray();
      for (const [id, age, who] of [
        ['msg-1', '2m', person.name],
        ['gone', '1h', 'Source unavailable'],
      ]) {
        const row = tree.root.findByProps({ testID: `bookmark-${id}` });
        const head = row.findByProps({ testID: `bookmark-save-line-${id}` });
        // The age alone at the right, as in Needs you: no SAVED stamp, no OPEN.
        expect(scope1.texts(head)).toEqual([who, age]);
        const words = scope1.texts(row);
        expect(words.join(' ')).not.toMatch(/SAVED|OPEN/);
        expect(words.filter((word) => word === age)).toHaveLength(1);
        expect(words).not.toContain(id === 'gone' ? '1d' : '2h');
        expect(words.includes('REMOVE')).toBe(remove || id === 'gone');
        // Where it is comes last, after the quoted words.
        const children = row
          .findAll(
            (node: any) =>
              typeof node.props.testID === 'string' &&
              /^bookmark-(save-line|text|source)-/.test(node.props.testID) &&
              typeof node.type === 'string',
          )
          .map((node: any) => node.props.testID.replace(`-${id}`, ''));
        expect(
          children.filter((key: string, index: number) => children.indexOf(key) === index),
        ).toEqual(
          id === 'gone'
            ? ['bookmark-save-line', 'bookmark-source']
            : ['bookmark-save-line', 'bookmark-text', 'bookmark-source'],
        );
        expect(scope1.texts(row.findByProps({ testID: `bookmark-source-${id}` })).join('')).toBe(
          'Fix fixture',
        );
      }
      // Bold reads as bold; no raw ** reaches the reader.
      const preview = tree.root.findByProps({ testID: 'bookmark-text-msg-1' });
      const read = (node: any): string =>
        typeof node === 'string' ? node : (node.children ?? []).map(read).join('');
      expect(read(preview)).not.toContain('**');
      expect(read(preview)).toBe(
        'Attached Inscriptions—ancient signs, personal color.\n\nUnclosed',
      );
      const bold = preview
        .findAllByType('Text' as any)
        .filter(
          (node: any) =>
            node !== preview &&
            node.props.children === 'Inscriptions—ancient signs, personal color.',
        );
      expect(bold.length).toBeGreaterThan(0);
      // A row with no source leaves no empty bottom line.
      expect(tree.root.findAllByProps({ testID: 'bookmark-source-nowhere' })).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });
});
describe('Tray opened without a communityId', () => {
  it('reads the Tray of the active Workspace', async () => {
    route.params = {};
    workspaceSet.active = 'ws';
    workspaceSet.workspaces = [{ id: 'other' }, { id: 'ws' }];
    const tree = await renderTray();
    expect(phoneOperation).toHaveBeenCalledWith('readTray', { workspaceId: 'ws', markSeen: false });
    expect(tree.root.findAllByProps({ testID: 'tray-loader' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'bookmark-msg-1' })).toBeTruthy();
  });


  it('shows a way back to Rooms when no Workspace resolves', async () => {
    route.params = {};
    const tree = await renderTray();
    expect(phoneOperation).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'tray-loader' })).toHaveLength(0);
    const fallback = tree.root.findByProps({ testID: 'tray-no-workspace' });
    await act(async () => {
      fallback.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });
});
describe('Bookmarks desktop second pane', () => {
  it('shows the workspace above Tray with no counters beside it', async () => {
    const tree = await renderTray();
    const header = tree.root.findByProps({ testID: 'tray-header' });
    const words = header.findAllByType('Text' as any).map((node: any) => node.props.children);
    expect(words).toEqual(['Clover Workspace', 'Tray']);
  });

  it('opens a clicked corner bookmark in DesktopRoomInspector at that message', async () => {
    serve({
      bookmarks: [
        bookmark(),
        bookmark({
          messageId: 'msg-2',
          roomId: 'corner-1',
          text: 'A later save.',
        }),
      ],
    });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-msg-2' }).props.onPress();
    });
    await act(async () => undefined);

    const pane = tree.root.findByType('DesktopRoomInspector' as any);
    expect(pane.props.content).toEqual({ kind: 'corner', cornerId: 'corner-1' });
    expect(pane.props.focusMessageId).toBe('msg-2');
    expect(pane.props.room.room.id).toBe('room-1');
    expect(textOf(tree)).not.toContain('OPEN IN');
    expect(tree.root.findAllByProps({ testID: 'tray-pane' })).toHaveLength(0);
  });


  it('does not restate an unavailable bookmark in the second pane', async () => {
    serve({
      bookmarks: [
        bookmark({
          messageId: 'gone',
          available: false,
          text: undefined,
          author: undefined,
        }),
      ],
    });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-gone' }).props.onPress?.();
    });
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
    const pane = tree.root.findByProps({ testID: 'tray-pane' });
    const paneText = pane
      .findAllByType('Text' as any)
      .flatMap((node: any) => node.props.children)
      .join(' ');
    expect(paneText).toContain('Source unavailable');
    expect(paneText).toContain('This bookmark no longer exposes message content.');
    expect(paneText).toContain('Remove');
    expect(paneText).not.toContain('The bookmarked line.');
    expect(paneText).not.toContain('Avery');
    expect(roomRead).not.toHaveBeenCalled();
  });
});
describe('Bookmarks mobile list', () => {
  it('lets its last item scroll clear of the system navigation bar', async () => {
    safeArea.bottom = 48;
    try {
      layout.os = 'android';
      layout.width = 390;
      const renderer = await renderTray();
      const scroll = renderer.root.findByType('FlatList' as never);
      const contentStyle = Object.assign(
        {},
        ...[scroll.props.contentContainerStyle].flat(Infinity as 1),
      );
      expect(contentStyle.paddingBottom).toBe(24 + 48);
    } finally {
      safeArea.bottom = 0;
    }
  });


  it('keeps the removed-bookmark undo clear of the system navigation bar', async () => {
    safeArea.bottom = 48;
    try {
      layout.os = 'android';
      layout.width = 390;
      serve({ bookmarks: [bookmark({ messageId: 'gone', available: false, text: undefined })] });
      const renderer = await renderTray();
      await act(async () => {
        await renderer.root
          .findByProps({ accessibilityLabel: 'Remove unavailable bookmark' })
          .props.onPress();
      });
      const undo = renderer.root.findByProps({ testID: 'bookmark-undo' });
      expect(Object.assign({}, ...[undo.props.style].flat(Infinity as 1)).bottom).toBe(16 + 48);
    } finally {
      safeArea.bottom = 0;
    }
  });
});
describe('Bookmarks empty state', () => {
  it('tells a desktop reader about the strip its pointer reaches, and nothing about long press', async () => {
    serve({ bookmarks: [] });
    const tree = await renderTray();
    const empty = textOf(tree);
    for (const testID of ['needs-you-empty', 'bookmarks-empty']) {
      const section = tree.root.findByProps({ testID });
      expect(section.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
      const detail = section.findAllByType('Text' as any)[1];
      expect(detail.props.style.color).toBe(theme.buzz.textSecondary);
    }
    expect(empty).toContain('Nothing needs you');
    expect(empty).toContain('Nobody has tagged you with a question or a request.');
    expect(empty).toContain('No bookmarks yet');
    expect(empty).toContain('Hover a message and press its bookmark mark.');
    expect(empty).not.toContain('Long press');
  });


  it('tells a touch reader to long press, and nothing about a desktop strip', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ bookmarks: [] });
    const tree = await renderTray();
    const empty = textOf(tree);
    for (const testID of ['needs-you-empty', 'bookmarks-empty']) {
      const section = tree.root.findByProps({ testID });
      expect(section.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
      const detail = section.findAllByType('Text' as any)[1];
      expect(detail.props.style.color).toBe(theme.buzz.textSecondary);
    }
    expect(empty).toContain('Nothing needs you');
    expect(empty).toContain('Nobody has tagged you with a question or a request.');
    expect(empty).toContain('No bookmarks yet');
    expect(empty).toContain('Long press a message and pick Bookmark.');
    expect(empty).not.toContain('desktop');
    expect(empty).not.toContain('Hover');
  });
});
describe('Bookmarks mobile open', () => {
  it('keeps a live removal while an older saved page finishes loading', async () => {
    let finishPage!: (value: { bookmarks: ReturnType<typeof bookmark>[] }) => void;
    phoneOperation.mockImplementation((name: string, input?: { before?: string }) => {
      if (name === 'readTray')
        return Promise.resolve({
          needs: { items: [] },
          saved: { bookmarks: [bookmark()], next: 'cursor' },
        });
      if (name === 'readNeedsYou') return Promise.resolve({ items: [] });
      if (name === 'listMessageBookmarks')
        return input?.before
          ? new Promise((resolve) => {
              finishPage = resolve;
            })
          : Promise.resolve({ bookmarks: [bookmark()], next: 'cursor' });
      return Promise.resolve(undefined);
    });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'bookmarks-more' }).props.onPress());
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({
          monolithLive: {
            type: 'bookmark-delta',
            roomId: '',
            workspaceId: 'ws',
            messageId: 'msg-2',
            bookmark: null,
          },
        });
    });
    await act(async () =>
      finishPage({
        bookmarks: [
          bookmark({ messageId: 'msg-2', bookmarkedAt: 1_700_000_050 }),
          bookmark({ messageId: 'msg-3', bookmarkedAt: 1_700_000_040 }),
        ],
      }),
    );
    expect(tree.root.findAllByProps({ testID: 'bookmark-msg-2' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'bookmark-msg-3' }).length).toBeGreaterThan(0);
    expect(
      phoneOperation.mock.calls.filter(([name]) => name === 'listMessageBookmarks'),
    ).toHaveLength(1);
  });


  it('keeps a live removal when an older covering read finishes afterward', async () => {
    let finishSaved!: (value: { bookmarks: ReturnType<typeof bookmark>[] }) => void;
    phoneOperation.mockImplementation((name: string) =>
      name === 'readNeedsYou'
        ? Promise.resolve({ items: [] })
        : name === 'readTray'
          ? new Promise((resolve) => {
              finishSaved = (value) => resolve({ needs: { items: [] }, saved: value });
            })
          : name === 'listMessageBookmarks'
            ? new Promise((resolve) => {
                finishSaved = resolve;
              })
            : Promise.resolve(undefined),
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<TrayScreen />);
    });
    mountedTrees.push(tree);
    await act(async () => undefined);
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({
          monolithLive: {
            type: 'bookmark-delta',
            roomId: '',
            workspaceId: 'ws',
            messageId: 'msg-1',
            bookmark: null,
          },
        });
    });
    await act(async () => finishSaved({ bookmarks: [bookmark()] }));
    expect(tree.root.findAllByProps({ testID: 'bookmark-msg-1' })).toHaveLength(0);
  });


  it('applies a saved-row removal from live without another list read', async () => {
    const tree = await renderTray();
    const reads = phoneOperation.mock.calls.filter(
      ([name]) => name === 'listMessageBookmarks',
    ).length;
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({
          monolithLive: {
            type: 'bookmark-delta',
            roomId: '',
            workspaceId: 'ws',
            messageId: 'msg-1',
            bookmark: null,
          },
        });
    });
    expect(tree.root.findAllByProps({ testID: 'bookmark-msg-1' })).toHaveLength(0);
    expect(
      phoneOperation.mock.calls.filter(([name]) => name === 'listMessageBookmarks'),
    ).toHaveLength(reads);
  });

  it('opens the original message in its room from a compact tap', async () => {
    layout.os = 'ios';
    layout.width = 390;
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-msg-1' }).props.onPress();
    });
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId: 'corner-1',
        communityId: 'ws',
        notificationResponseId: 'bookmark:msg-1',
        notificationMessageId: 'msg-1',
      },
    });
    expect(prefetchRoom).toHaveBeenCalledWith('bookmark:msg-1', 'corner-1');
    expect(prefetchRoom.mock.invocationCallOrder[0]).toBeLessThan(
      navigation.push.mock.invocationCallOrder[0],
    );
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
  });


  it('shows No Workspace instead of stale items once the person leaves the Workspace', async () => {
    layout.os = 'ios';
    layout.width = 390;
    {
      const tree = await renderTray();
      expect(tree.root.findByProps({ testID: 'bookmark-msg-1' })).toBeTruthy();
      phoneOperation.mockImplementation(async () => {
        throw Object.assign(
          new Error('Monolith readNeedsYou failed (400): workspace membership required'),
          {
            code: 'workspace membership required',
          },
        );
      });
      await returnToForeground();
      expect(tree.root.findAllByProps({ testID: 'bookmark-msg-1' })).toHaveLength(0);
      expect(tree.root.findByProps({ testID: 'tray-no-workspace' })).toBeTruthy();
      expect(textOf(tree)).toContain('You are no longer a member of this Workspace.');
      expect(textOf(tree)).not.toContain('Retry');
    }
  });


  it('keeps No Workspace when a refresh after membership loss fails for another reason', async () => {
    {
      const tree = await renderTray();
      phoneOperation.mockImplementation(async () => {
        throw Object.assign(
          new Error('Monolith readNeedsYou failed (400): workspace membership required'),
          {
            code: 'workspace membership required',
          },
        );
      });
      await returnToForeground();
      expect(tree.root.findByProps({ testID: 'tray-no-workspace' })).toBeTruthy();
      phoneOperation.mockImplementation(async () => {
        throw Object.assign(new Error('Monolith readNeedsYou failed (503): unavailable'), {
          code: 'unavailable',
        });
      });
      await returnToForeground();
      expect(tree.root.findByProps({ testID: 'tray-no-workspace' })).toBeTruthy();
      expect(textOf(tree)).toContain('You are no longer a member of this Workspace.');
      expect(textOf(tree)).not.toContain('Retry');
      serve({ bookmarks: [bookmark()] });
      await returnToForeground();
      expect(tree.root.findAllByProps({ testID: 'tray-no-workspace' })).toHaveLength(0);
      expect(tree.root.findByProps({ testID: 'bookmark-msg-1' })).toBeTruthy();
    }
  });


  it('keeps the items and offers Retry when a refresh fails for another reason', async () => {
    {
      const tree = await renderTray();
      phoneOperation.mockImplementation(async () => {
        throw Object.assign(new Error('Monolith readNeedsYou failed (503): unavailable'), {
          code: 'unavailable',
        });
      });
      await returnToForeground();
      expect(tree.root.findByProps({ testID: 'bookmark-msg-1' })).toBeTruthy();
      expect(tree.root.findAllByProps({ testID: 'tray-no-workspace' })).toHaveLength(0);
      expect(textOf(tree)).toContain('Retry');
    }
  });
});
describe('Needs-you badge and tray', () => {
const scope7 = fixtureScope7();


  it.each([0, 1, 2, 9, 12])(
    'TRAY-CACHED-EMPTY-1: cold badge read seeds %i rows despite stale disk',
    async (count) => {
      const needs = Array.from({ length: count }, (_, i) => need({ messageId: `ask-${i}` }));
      scope7.serveNeeds({ needs });
      vi.mocked(mobileSurfaceCache.read).mockResolvedValue({ items: [], bookmarks: [] } as never);
      const tree = await scope7.render(false);
      expect(scope7.badge(tree)).toBe(count);
      await act(async () => tree.update(<scope7.BadgeAndTray tray />));
      const visible = tree.root.findAll(
        (node: any) =>
          typeof node.type === 'string' &&
          /^needs-you-ask-\d+$/.test(String(node.props.testID ?? '')),
      ).length;
      expect([visible, scope7.badge(tree)]).toEqual([count, count]);
      expect(phoneOperation.mock.calls.filter(([name]) => name === 'readNeedsYou')).toHaveLength(1);
      expect(phoneOperation.mock.calls.map(([name]) => name)).toEqual(['readNeedsYou']);
      vi.mocked(mobileSurfaceCache.read).mockResolvedValue(null);
    },
  );


  it('keeps badge and local rows equal through live changes and held removals', async () => {
    scope7.serveNeeds({ needs: [need()] });
    function Probe() {
      const count = useNeedsYouCount('ws', 1);
      const { needs } = useTrayList('ws');
      return React.createElement('Text', { testID: 'pair' }, [needs?.length ?? 0, count].join(':'));
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe />);
    });
    mountedTrees.push(tree);
    const pair = () => tree.root.findByProps({ testID: 'pair' }).props.children;
    expect(pair()).toBe('1:1');
    await act(async () =>
      applyNeedsYouLiveDelta({
        workspaceId: 'ws',
        sourceRoomId: 'room-2',
        count: 2,
        items: [need({ messageId: 'ask-2', roomId: 'room-2' })] as never,
      }),
    );
    expect(pair()).toBe('2:2');
    await act(async () => holdNeedsYou('ws', ['ask-1']));
    expect(pair()).toBe('1:1');
    await act(async () =>
      applyNeedsYouLiveDelta({ workspaceId: 'ws', sourceRoomId: 'room-2', count: 1, items: [] }),
    );
    expect(pair()).toBe('0:0');
    await act(async () => holdNeedsYou('ws', []));
    expect(pair()).toBe('1:1');
  });


  it('BACK-BURST-1: leaves count badges idle when live rows keep the same count', async () => {
    scope7.serveNeeds({ needs: [] });
    let badgeRenders = 0;
    function CountBadge() {
      badgeRenders += 1;
      return React.createElement('Text', { testID: 'count-only' }, useNeedsYouCount('ws', 1));
    }
    function TrayRows() {
      const { needs } = useTrayList('ws');
      return React.createElement(
        'Text',
        { testID: 'live-rows' },
        needs?.map((item) => item.text).join('|'),
      );
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <>
          <CountBadge />
          <TrayRows />
        </>,
      );
    });
    mountedTrees.push(tree);
    badgeRenders = 0;
    for (let index = 0; index < 25; index += 1) {
      await act(async () =>
        applyNeedsYouLiveDelta({ workspaceId: 'ws', sourceRoomId: 'room-2', count: 0, items: [] }),
      );
    }
    expect(badgeRenders).toBe(0);
    await act(async () =>
      applyNeedsYouLiveDelta({
        workspaceId: 'ws',
        sourceRoomId: 'room-2',
        count: 1,
        items: [need({ messageId: 'ask-2', roomId: 'room-2', text: 'First question?' })] as never,
      }),
    );
    expect(tree.root.findByProps({ testID: 'count-only' }).props.children).toBe(1);
    badgeRenders = 0;
    await act(async () =>
      applyNeedsYouLiveDelta({
        workspaceId: 'ws',
        sourceRoomId: 'room-2',
        count: 1,
        items: [need({ messageId: 'ask-2', roomId: 'room-2', text: 'Updated question?' })] as never,
      }),
    );
    expect(badgeRenders).toBe(0);
    expect(tree.root.findByProps({ testID: 'live-rows' }).props.children).toBe('Updated question?');
  });


  it('shares concurrent badge reads and replays live rows that arrive during the read', async () => {
    let answer!: (value: { items: unknown[] }) => void;
    phoneOperation.mockImplementation((name: string) => {
      if (name !== 'readNeedsYou') throw new Error(`Unexpected request ${name}`);
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    function Probe() {
      const first = useNeedsYouCount('ws', 1);
      const second = useNeedsYouCount('ws', 1);
      const { needs } = useTrayList('ws');
      return React.createElement(
        'Text',
        { testID: 'pair' },
        [first, second, needs?.length ?? 0].join(':'),
      );
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Probe />);
    });
    mountedTrees.push(tree);
    expect(phoneOperation).toHaveBeenCalledTimes(1);
    await act(async () =>
      applyNeedsYouLiveDelta({
        workspaceId: 'ws',
        sourceRoomId: 'room-2',
        count: 2,
        items: [need({ messageId: 'ask-2', roomId: 'room-2' })] as never,
      }),
    );
    await act(async () => answer({ items: [need()] }));
    expect(tree.root.findByProps({ testID: 'pair' }).props.children).toBe('2:2:2');
  });


  it('acknowledges exactly painted unseen questions once; badge and reopening send none', async () => {
    const unseen = need({ expiresAt: undefined });
    const offscreen = need({ messageId: 'ask-2', expiresAt: undefined });
    scope7.serveNeeds({ needs: [unseen, offscreen] });
    const original = phoneOperation.getMockImplementation()!;
    phoneOperation.mockImplementation(async (name: string, input: any) =>
      name === 'markNeedsYouSeen'
        ? {
            seen: input.messageIds.map((messageId: string) => ({
              messageId,
              expiresAt: 2_000_000_000,
            })),
          }
        : original(name, input),
    );
    const tree = await scope7.render(false);
    expect(phoneOperation.mock.calls.map(([name]) => name)).toEqual(['readNeedsYou']);
    await act(async () => tree.update(<scope7.BadgeAndTray tray />));
    const painted = () =>
      tree.root.findByType('FlatList' as never).props.onViewableItemsChanged({
        viewableItems: [{ isViewable: true, item: { type: 'needs', item: unseen } }],
      });
    await act(async () => {
      painted();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'markNeedsYouSeen')).toEqual([
      ['markNeedsYouSeen', { workspaceId: 'ws', messageIds: ['ask-1'] }],
    ]);
    await act(async () => tree.update(<scope7.BadgeAndTray tray={false} />));
    await act(async () => tree.update(<scope7.BadgeAndTray tray />));
    await act(async () => {
      painted();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'markNeedsYouSeen')).toHaveLength(
      1,
    );
    // A second genuinely visible question starts its own clock, not before.
    await act(async () => acknowledgePaintedNeedsYou('ws', ['ask-2']));
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'markNeedsYouSeen')).toHaveLength(
      2,
    );
  });


  it('batches viewable unseen questions and does not acknowledge background paint or seen rows', async () => {
    const questions = [
      need({ expiresAt: undefined }),
      need({ messageId: 'ask-2', expiresAt: undefined }),
    ];
    const seen = need({ messageId: 'ask-3' });
    scope7.serveNeeds({ needs: [...questions, seen] });
    const original = phoneOperation.getMockImplementation()!;
    phoneOperation.mockImplementation(async (name: string, input: any) =>
      name === 'markNeedsYouSeen'
        ? {
            seen: input.messageIds.map((messageId: string) => ({
              messageId,
              expiresAt: 2_000_000_000,
            })),
          }
        : original(name, input),
    );
    const tree = await scope7.render(true);
    const callback = tree.root.findByType('FlatList' as never).props.onViewableItemsChanged;
    const viewableItems = [...questions, seen].map((item) => ({
      isViewable: true,
      item: { type: 'needs', item },
    }));
    appState.current = 'background';
    await act(async () => {
      callback({ viewableItems });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'markNeedsYouSeen')).toHaveLength(
      0,
    );
    appState.current = 'active';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'markNeedsYouSeen')).toHaveLength(
      0,
    );
    await act(async () => {
      callback({ viewableItems });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(phoneOperation.mock.calls.filter(([name]) => name === 'markNeedsYouSeen')).toEqual([
      ['markNeedsYouSeen', { workspaceId: 'ws', messageIds: ['ask-1', 'ask-2'] }],
    ]);
  });


  it('Reproduction NEEDS-YOU-BADGE-1: a dismiss drops the badge with the list', async () => {
    scope7.serveNeeds({ needs: [need(), need({ messageId: 'ask-2' })] });
    const tree = await scope7.render(true);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([2, 2]);
    await scope7.swipe(tree, 'ask-1');
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
  });


  it('a failed clear puts the cell back in the list and the badge', async () => {
    scope7.serveNeeds({ needs: [need(), need({ messageId: 'ask-2' })], failClear: true });
    const tree = await scope7.render(true);
    await scope7.swipe(tree, 'ask-1');
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([2, 2]);
  });


  it('a held section clear hides the cells from the badge until Undo', async () => {
    scope7.serveNeeds({ needs: [need(), need({ messageId: 'ask-2' })] });
    const tree = await scope7.render(true);
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([0, 0]);
    await act(async () =>
      tree.root
        .findByProps({ testID: 'tray-clear-undo' })
        .findByProps({ accessibilityRole: 'button' })
        .props.onPress(),
    );
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([2, 2]);
  });


  it('a reconnect after the tray closed counts again instead of keeping the old list', async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const tree = await scope7.render(true);
    expect(scope7.badge(tree)).toBe(2);
    await act(async () => tree.update(<scope7.BadgeAndTray tray={false} />));
    server.needs = [need()];
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
    });
    // The fresh count resolves after the viewer and the request settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(scope7.badge(tree)).toBe(1);
  });
});
