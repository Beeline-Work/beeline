import { layout, navigation, phoneOperation, liveRegistrations, auth, applyNeedsYouLiveDelta, bookmark, need, serve, textOf, renderTray, fixtureScope7, fixtureScope8, fixtureScope9 } from './test-support-tray.test-support';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { resetClientState } from '@/sync/client-reset';

describe('Needs-you badge and tray', () => {
const scope7 = fixtureScope7();


  it('an open tray re-reads on a gap and the badge follows it', async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const tree = await scope7.render(true);
    server.needs = [need()];
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'needs-you-gap' } });
    });
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
  });


  it('Reproduction NEEDS-YOU-READ-ORDER-1: an older gap read that finishes last does not undo a newer one', async () => {
    scope7.serveNeeds({ needs: [need(), need({ messageId: 'ask-2' })] });
    const tree = await scope7.render(true);
    const answers: Array<(value: { items: unknown[] }) => void> = [];
    phoneOperation.mockImplementation((name: string) => {
      if (name === 'readNeedsYou')
        return new Promise((resolve) => {
          answers.push(resolve);
        });
      if (name === 'listMessageBookmarks') return Promise.resolve({ bookmarks: [] });
      return Promise.resolve(undefined);
    });
    for (let gap = 0; gap < 2; gap += 1) {
      await act(async () => {
        for (const listener of [...liveRegistrations])
          listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'needs-you-gap' } });
      });
      await act(async () => undefined);
    }
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]({ items: [need()] }));
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
    await act(async () => answers[0]({ items: [need(), need({ messageId: 'ask-2' })] }));
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
  });


  it('Reproduction NEEDS-YOU-READ-CLEAR-1: a gap read started before a dismiss does not bring the cell back', async () => {
    scope7.serveNeeds({ needs: [need(), need({ messageId: 'ask-2' })] });
    const tree = await scope7.render(true);
    const answers: Array<(value: { items: unknown[] }) => void> = [];
    phoneOperation.mockImplementation((name: string) => {
      if (name === 'readNeedsYou')
        return new Promise((resolve) => {
          answers.push(resolve);
        });
      if (name === 'listMessageBookmarks') return Promise.resolve({ bookmarks: [] });
      return Promise.resolve(undefined);
    });
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'needs-you-gap' } });
    });
    await act(async () => undefined);
    expect(answers).toHaveLength(1);
    await scope7.swipe(tree, 'ask-2');
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
    await act(async () => answers[0]({ items: [need(), need({ messageId: 'ask-2' })] }));
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
  });


  it('Reproduction NEEDS-YOU-READ-CLEAR-2: a gap read started during a pending dismiss does not bring the cell back', async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const tree = await scope7.render(true);
    const held = scope7.holdClearsAndReads(server);
    await scope7.swipe(tree, 'ask-2');
    expect(held.clears).toHaveLength(1);
    // The read starts before the server applies the clear, so it still sees both cells.
    await scope7.gap();
    expect(held.reads).toHaveLength(1);
    await act(async () => held.clears[0]!.ok());
    await act(async () => held.reads[0]!());
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
  });


  it('a gap read that answers while a dismiss is still pending leaves the cell out', async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const tree = await scope7.render(true);
    const held = scope7.holdClearsAndReads(server);
    await scope7.swipe(tree, 'ask-2');
    await scope7.gap();
    await act(async () => held.reads[0]!());
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
    await act(async () => held.clears[0]!.ok());
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([1, 1]);
  });


  it('a dismiss that fails while a gap read is pending puts the cell back once', async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const tree = await scope7.render(true);
    const held = scope7.holdClearsAndReads(server);
    await scope7.swipe(tree, 'ask-2');
    await scope7.gap();
    await act(async () => held.clears[0]!.fail());
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([2, 2]);
    await act(async () => held.reads[0]!());
    await act(async () => undefined);
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([2, 2]);
  });


  it('a gap read started during a pending section clear does not bring the cells back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
      scope7.serveNeeds(server);
      const tree = await scope7.render(true);
      const held = scope7.holdClearsAndReads(server);
      await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });
      expect(held.clears).toHaveLength(1);
      await scope7.gap();
      await act(async () => held.clears[0]!.ok());
      await act(async () => held.reads[0]!());
      await act(async () => undefined);
      expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });


  it("a client reset forgets the previous account's pending clears", async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const treeA = await scope7.render(true);
    scope7.holdClearsAndReads(server);
    await scope7.swipe(treeA, 'ask-2');
    await act(async () => treeA.unmount());
    // B's server holds a cell with the same id; A's pending clear must not hide it.
    scope7.serveNeeds(server);
    auth.loadBuzzIdentity.mockImplementation(async () => ({ publicKey: 'other-viewer' }));
    await act(async () => resetClientState());
    const treeB = await scope7.render(true);
    expect([scope7.rows(treeB), scope7.badge(treeB)]).toEqual([2, 2]);
  });


  it('a live delta moves the badge and the list together', async () => {
    scope7.serveNeeds({ needs: [need()] });
    const tree = await scope7.render(true);
    await act(async () =>
      applyNeedsYouLiveDelta({
        workspaceId: 'ws',
        sourceRoomId: 'room-2',
        count: 2,
        items: [need({ messageId: 'ask-2', roomId: 'room-2' })] as never,
      }),
    );
    expect([scope7.rows(tree), scope7.badge(tree)]).toEqual([2, 2]);
  });


  it("an account switch never shows the previous account's count", async () => {
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    scope7.serveNeeds(server);
    const tree = await scope7.render(false);
    expect(scope7.badge(tree)).toBe(2);
    let answerCount!: (value: { items: unknown[] }) => void;
    phoneOperation.mockImplementation((name: string) =>
      name === 'readNeedsYou'
        ? new Promise((resolve) => {
            answerCount = resolve;
          })
        : Promise.resolve(undefined),
    );
    auth.loadBuzzIdentity.mockImplementation(async () => ({ publicKey: 'other-viewer' }));
    await act(async () => {
      resetClientState();
    });
    await act(async () => undefined);
    expect(scope7.badge(tree)).toBe(0);
    await act(async () => answerCount({ items: [] }));
    expect(scope7.badge(tree)).toBe(0);
  });


  it('a projection read for the previous account writes nothing after a client reset', async () => {
    const answers: Array<(value: { items: unknown[] }) => void> = [];
    phoneOperation.mockImplementation((name: string) =>
      name === 'readNeedsYou'
        ? new Promise((resolve) => {
            answers.push(resolve);
          })
        : Promise.resolve(undefined),
    );
    const tree = await scope7.render(false);
    expect(answers).toHaveLength(1);
    auth.loadBuzzIdentity.mockImplementation(async () => ({ publicKey: 'other-viewer' }));
    await act(async () => resetClientState());
    await act(async () => undefined);
    // The reset dropped the shared request, so the new account asks on its own.
    expect(answers).toHaveLength(2);
    await act(async () =>
      answers[0]!({ items: Array.from({ length: 7 }, (_, i) => need({ messageId: `ask-${i}` })) }),
    );
    expect(scope7.badge(tree)).toBe(0);
    await act(async () => answers[1]!({ items: [need()] }));
    expect(scope7.badge(tree)).toBe(1);
  });


  it('a clear that fails after an account switch leaves the new account alone', async () => {
    const a = scope7.serveSwitch();
    const treeA = await scope7.render(true);
    await scope7.swipe(treeA, 'ask-1');
    expect([scope7.rows(treeA), scope7.badge(treeA)]).toEqual([1, 1]);
    await act(async () => treeA.unmount());
    const treeB = await a.switchToB();
    expect([scope7.rows(treeB), scope7.badge(treeB)]).toEqual([1, 1]);
    await act(async () => a.fail());
    await act(async () => undefined);
    expect([scope7.rows(treeB), scope7.badge(treeB)]).toEqual([1, 1]);
  });


  it('a section clear that fails after an account switch leaves the new account alone', async () => {
    const a = scope7.serveSwitch();
    const treeA = await scope7.render(true);
    await act(async () => treeA.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    // Leaving the tray sends the held clear at once.
    await act(async () => treeA.update(<scope7.BadgeAndTray tray={false} />));
    expect(phoneOperation.mock.calls.some(([name]) => name === 'clearNeedsYouSection')).toBe(true);
    await act(async () => treeA.unmount());
    const treeB = await a.switchToB();
    expect([scope7.rows(treeB), scope7.badge(treeB)]).toEqual([1, 1]);
    await act(async () => a.fail());
    await act(async () => undefined);
    expect([scope7.rows(treeB), scope7.badge(treeB)]).toEqual([1, 1]);
  });
});
describe('Tray Needs you', () => {
const scope8 = fixtureScope8();


  it('shows Needs you then Saved, each question cell its asker, sentence and source', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_300_000);
    serve({
      needs: [need(), need({ messageId: 'ask-2', roomKind: 'corner', roomName: 'signing' })],
      bookmarks: [bookmark()],
    });
    try {
      const tree = await renderTray();
      const order = tree.root
        .findAll((node: any) =>
          /^(tray-section-|needs-you-ask|bookmark-msg)/.test(String(node.props.testID ?? '')),
        )
        .map((node: any) => node.props.testID)
        .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index)
        .filter((id: string) => !/^needs-you-(text|head|age)-/.test(id));
      expect(order).toEqual([
        'tray-section-needs',
        'needs-you-ask-1',
        'needs-you-ask-2',
        'tray-section-saved',
        'bookmark-msg-1',
      ]);
      const cell = tree.root.findByProps({ testID: 'needs-you-text-ask-1' });
      expect(cell.props.children).toBe('can you confirm the review note?');
      expect(textOf(tree)).not.toContain('@');
      expect(textOf(tree)).toContain('Launch room');
      expect(tree.root.findByProps({ testID: 'needs-you-age-ask-1' }).props.children).toBe('5m');
    } finally {
      clock.mockRestore();
    }
  });


  it('lists approvals before questions in one Needs you section, and opening one leaves it in the tray', async () => {
    layout.os = 'ios';
    layout.width = 390;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000 + 2 * 86_400_000);
    serve({
      needs: [
        need({
          messageId: 'grant-1',
          roomKind: 'corner',
          roomName: 'sec-filing-desk',
          parentRoomName: 'experiments',
          text: 'Allow running git push --force-with-lease?',
          expiresAt: undefined,
          approval: {
            kind: 'grant',
            actor: 'BBC',
            ask: 'asks to run',
            subject: 'git push --force-with-lease',
            literal: true,
            detail: 'Push ledger fixes to feat/ledger.',
            forName: 'Johnny',
          },
        }),
        need({ createdAt: 1_700_000_000 + 2 * 86_400 - 300 }),
      ],
    });
    try {
      const tree = await renderTray();
      const sections = tree.root
        .findAll((node: any) => /^tray-section-/.test(String(node.props.testID ?? '')))
        .map((node: any) => node.props.testID)
        .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);
      expect(sections).toEqual(['tray-section-needs', 'tray-section-saved']);
      const cells = tree.root
        .findAll((node: any) => /^needs-you-(grant|ask)-1$/.test(String(node.props.testID ?? '')))
        .map((node: any) => node.props.testID)
        .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);
      expect(cells).toEqual(['needs-you-grant-1', 'needs-you-ask-1']);
      const head = tree.root.findByProps({ testID: 'needs-you-head-grant-1' });
      const [actor, ask] = head.props.children;
      expect(actor.props.children).toBe('BBC');
      expect(ask).toBe(' asks to run');
      expect(tree.root.findByProps({ testID: 'needs-you-text-grant-1' }).props.children).toBe(
        'git push --force-with-lease',
      );
      expect(tree.root.findByProps({ testID: 'needs-you-detail-grant-1' }).props.children).toBe(
        'Push ledger fixes to feat/ledger.',
      );
      expect(textOf(tree)).toContain('experiments/sec-filing-desk · for @Johnny');
      // Older than a day: the age takes the warning tone.
      expect(textOf(tree)).toContain('2d');
      // Opening an approval leaves it; a separate swipe can dismiss its tray row.
      expect(
        tree.root.findAllByProps({ testID: 'needs-you-swipe-grant-1' }).length,
      ).toBeGreaterThan(0);
      await act(async () => {
        tree.root.findByProps({ testID: 'needs-you-grant-1' }).props.onPress();
      });
      expect(scope8.cleared()).toEqual([]);
      expect(navigation.push).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ notificationMessageId: 'grant-1' }),
        }),
      );
      expect(tree.root.findAllByProps({ testID: 'needs-you-grant-1' }).length).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
  });


  it('shows the countdown only in a cell’s last six hours', async () => {
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    serve({
      needs: [
        need({ expiresAt: now / 1000 + 5.5 * 3600 }),
        need({ messageId: 'ask-2', expiresAt: now / 1000 + 20 * 3600 }),
      ],
    });
    try {
      const text = textOf(await renderTray());
      expect(text).toContain('expires in 6h');
      expect(text.match(/expires in/g)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });


  it('opening a cell on the phone clears it and lands on that exact message', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-ask-1' }).props.onPress();
    });
    expect(scope8.cleared()).toEqual([['clearNeedsYou', { workspaceId: 'ws', messageId: 'ask-1' }]]);
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId: 'room-1',
        communityId: 'ws',
        notificationResponseId: 'needs-you:ask-1',
        notificationMessageId: 'ask-1',
      },
    });
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'needs-you-empty' })).toBeDefined();
  });


  it('a phone swipe right dismisses the cell without opening it', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-swipe-ask-1' }).props.onSwipeableOpen('left');
    });
    expect(scope8.cleared()).toHaveLength(1);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' })).toHaveLength(0);
  });


  it('a phone swipe dismisses an approval without deciding it', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({
      needs: [
        need({
          messageId: 'grant-1',
          approval: {
            kind: 'grant',
            actor: 'BBC',
            ask: 'asks to run',
            subject: 'git push',
            literal: true,
          },
        }),
      ],
    });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-swipe-grant-1' }).props.onSwipeableOpen('left');
    });
    expect(scope8.cleared()).toEqual([
      ['clearNeedsYou', { workspaceId: 'ws', messageId: 'grant-1', dismissReminder: true }],
    ]);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ testID: 'needs-you-empty' })).toBeDefined();
  });


  it('a desktop hover offers DISMISS for an approval', async () => {
    serve({
      needs: [
        need({
          messageId: 'grant-1',
          approval: {
            kind: 'grant',
            actor: 'BBC',
            ask: 'asks to run',
            subject: 'git push',
            literal: true,
          },
        }),
      ],
    });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'needs-you-grant-1' }).props.onHoverIn());
    await act(async () =>
      tree.root
        .findByProps({ testID: 'needs-you-dismiss-grant-1' })
        .props.onPress({ stopPropagation: () => undefined }),
    );
    expect(scope8.cleared()).toEqual([
      ['clearNeedsYou', { workspaceId: 'ws', messageId: 'grant-1', dismissReminder: true }],
    ]);
    expect(navigation.push).not.toHaveBeenCalled();
  });


  it('a desktop click clears the cell and keeps its message open in the pane', async () => {
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-ask-1' }).props.onPress();
    });
    await act(async () => undefined);
    expect(scope8.cleared()).toHaveLength(1);
    const pane = tree.root.findByType('DesktopRoomInspector' as any);
    expect(pane.props.focusMessageId).toBe('ask-1');
    expect(navigation.push).not.toHaveBeenCalled();
  });


  it('a desktop hover reveals DISMISS in place of the chevron', async () => {
    serve({ needs: [need()] });
    const tree = await renderTray();
    const cell = () => tree.root.findByProps({ testID: 'needs-you-ask-1' });
    expect(tree.root.findAllByProps({ testID: 'needs-you-dismiss-ask-1' })).toHaveLength(0);
    await act(async () => cell().props.onHoverIn());
    await act(async () => {
      tree.root
        .findByProps({ testID: 'needs-you-dismiss-ask-1' })
        .props.onPress({ stopPropagation: () => undefined });
    });
    expect(scope8.cleared()).toHaveLength(1);
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
  });


  it('an open tray drops a cell cleared on another device from a typed delta', async () => {
    {
      serve({ needs: [need()] });
      const tree = await renderTray();
      expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' }).length).toBeGreaterThan(0);
      await act(async () =>
        applyNeedsYouLiveDelta({ workspaceId: 'ws', sourceRoomId: 'room-1', count: 0, items: [] }),
      );
      expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' })).toHaveLength(0);
      expect(tree.root.findByProps({ testID: 'needs-you-empty' })).toBeDefined();
    }
  });


  it('an open tray applies a new cell without a timer or HTTP read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      serve({ needs: [need()] });
      await renderTray();
      const reads = () =>
        phoneOperation.mock.calls.filter(([name]) => name === 'readNeedsYou').length;
      const opened = reads();
      await act(async () => {
        vi.advanceTimersByTime(30 * 60_000);
      });
      expect(reads()).toBe(opened);
      await act(async () =>
        applyNeedsYouLiveDelta({
          workspaceId: 'ws',
          sourceRoomId: 'room-1',
          count: 2,
          items: [need(), need({ messageId: 'ask-2', text: 'please check this too' })],
        }),
      );
      await act(async () => undefined);
      expect(reads()).toBe(opened);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts a cell back when the server refuses to clear it', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ needs: [need()] });
    const tree = await renderTray();
    phoneOperation.mockImplementation(async (name: string) => {
      if (name === 'clearNeedsYou') throw new Error('message is not available');
      return undefined;
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-swipe-ask-1' }).props.onSwipeableOpen('left');
    });
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' }).length).toBeGreaterThan(0);
    expect(textOf(tree)).toContain('message is not available');
  });
});
describe('Tray section CLEAR', () => {
const scope9 = fixtureScope9();


  it.each([
    { surface: 'desktop', os: 'web', width: 1200 },
    { surface: 'mobile', os: 'ios', width: 390 },
  ])(
    'clears every question and approval on $surface after the Undo window',
    async ({ os, width }) => {
      layout.os = os;
      layout.width = width;
      serve({ needs: [scope9.approval(), need(), need({ messageId: 'ask-2' })] });
      const tree = await renderTray();
      await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
      expect(scope9.ids(tree, /^needs-you-(grant|ask)-\d$/)).toEqual([]);
      expect(textOf(tree)).toContain('Cleared 3 items');
      expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });
      expect(scope9.calls('clearNeedsYouSection')).toEqual([
        ['clearNeedsYouSection', { workspaceId: 'ws' }],
      ]);
      expect(tree.root.findAllByProps({ testID: 'tray-clear-undo' })).toHaveLength(0);
      expect(tree.root.findByProps({ testID: 'needs-you-empty' })).toBeDefined();
      expect(tree.root.findAllByProps({ testID: 'tray-clear-needs' })).toHaveLength(0);
    },
  );


  it('shows CLEAR with approvals alone and dismisses all of them', async () => {
    serve({ needs: [scope9.approval(), need({ ...scope9.approval(), messageId: 'grant-2' })] });
    const tree = await renderTray();
    expect(tree.root.findByProps({ testID: 'tray-clear-needs' })).toBeDefined();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    expect(scope9.ids(tree, /^needs-you-grant-\d$/)).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.calls('clearNeedsYouSection')).toHaveLength(1);
    expect(tree.root.findByProps({ testID: 'needs-you-empty' })).toBeDefined();
  });


  it('UNDO brings every bookmark back and sends nothing', async () => {
    serve({ bookmarks: [bookmark(), bookmark({ messageId: 'msg-2' })] });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    expect(scope9.ids(tree, /^bookmark-msg-\d$/)).toEqual([]);
    expect(tree.root.findByProps({ testID: 'bookmarks-empty' })).toBeDefined();
    const undo = tree.root.findByProps({ testID: 'tray-clear-undo' });
    expect(textOf(tree)).toContain('Cleared 2 bookmarks');
    await act(async () => undo.findByProps({ accessibilityRole: 'button' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.ids(tree, /^bookmark-msg-\d$/)).toEqual(['bookmark-msg-1', 'bookmark-msg-2']);
    expect(scope9.calls('clearMessageBookmarks')).toEqual([]);
  });


  it('sends one Workspace operation for many bookmarks and stays empty after a reload', async () => {
    serve({
      bookmarks: Array.from({ length: 45 }, (_, index) => bookmark({ messageId: `msg-${index}` })),
    });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.calls('clearMessageBookmarks')).toEqual([
      ['clearMessageBookmarks', { workspaceId: 'ws' }],
    ]);
    expect(tree.root.findByProps({ testID: 'bookmarks-empty' })).toBeDefined();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(tree.root.findByProps({ testID: 'bookmarks-empty' })).toBeDefined();
  });


  it('puts back a bookmark the server refuses to clear', async () => {
    serve({ bookmarks: [bookmark(), bookmark({ messageId: 'msg-2' })] });
    const tree = await renderTray();
    phoneOperation.mockImplementation(async (name: string, input: any) => {
      if (name === 'clearMessageBookmarks') throw new Error('bookmark is locked');
      return undefined;
    });
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await act(async () => undefined);
    expect(scope9.calls('clearMessageBookmarks')).toEqual([
      ['clearMessageBookmarks', { workspaceId: 'ws' }],
    ]);
    expect(scope9.ids(tree, /^bookmark-msg-\d$/)).toEqual(['bookmark-msg-1', 'bookmark-msg-2']);
    expect(textOf(tree)).toContain('bookmark is locked');
  });


  it('Reproduction TRAY-UNDO-1: a second CLEAR keeps the first clear undoable for its full window', async () => {
    serve({ needs: [need()], bookmarks: [bookmark()] });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
    expect(textOf(tree)).toContain('Cleared 1 bookmark');
    // UNDO takes back the newest clear; the older one, still in its window, shows next.
    await act(async () =>
      tree.root
        .findByProps({ testID: 'tray-clear-undo' })
        .findByProps({ accessibilityRole: 'button' })
        .props.onPress(),
    );
    expect(textOf(tree)).toContain('Cleared 1 item');
    await act(async () =>
      tree.root
        .findByProps({ testID: 'tray-clear-undo' })
        .findByProps({ accessibilityRole: 'button' })
        .props.onPress(),
    );
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.ids(tree, /^(needs-you-ask|bookmark-msg)-\d$/)).toEqual([
      'needs-you-ask-1',
      'bookmark-msg-1',
    ]);
    expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
    expect(scope9.calls('clearMessageBookmarks')).toEqual([]);
  });


  it('sends each held clear when its own six seconds end', async () => {
    serve({ needs: [need()], bookmarks: [bookmark()] });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(4_999);
    });
    expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(scope9.calls('clearNeedsYouSection')).toHaveLength(1);
    expect(scope9.calls('clearMessageBookmarks')).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(scope9.calls('clearMessageBookmarks')).toHaveLength(1);
  });


  it('drops both held sections on account reset without sending either clear', async () => {
    serve({ needs: [need()], bookmarks: [bookmark()] });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    await act(async () => resetClientState());
    expect(tree.root.findAllByProps({ testID: 'tray-clear-undo' })).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
    expect(scope9.calls('clearMessageBookmarks')).toEqual([]);
  });


  it('REMOVE during the Undo window does not send the held clear', async () => {
    layout.os = 'android';
    layout.width = 390;
    serve({
      needs: [need()],
      bookmarks: [bookmark({ messageId: 'gone', available: false, text: undefined })],
    });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    await act(async () => {
      await tree.root
        .findByProps({ accessibilityLabel: 'Remove unavailable bookmark' })
        .props.onPress();
    });
    expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.calls('clearNeedsYouSection')).toHaveLength(1);
  });


  it('Reproduction TRAY-UNDO-REMOVE-1: bulk UNDO stays on screen after a REMOVE', async () => {
    layout.os = 'android';
    layout.width = 390;
    serve({
      needs: [need()],
      bookmarks: [bookmark({ messageId: 'gone', available: false, text: undefined })],
    });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      await tree.root
        .findByProps({ accessibilityLabel: 'Remove unavailable bookmark' })
        .props.onPress();
    });
    expect(scope9.ids(tree, /^(bookmark|tray-clear)-undo$/)).toEqual(['bookmark-undo', 'tray-clear-undo']);
    const undo = tree.root.findByProps({ testID: 'tray-clear-undo' });
    expect(textOf(tree)).toContain('Cleared 1 item');
    const bottom = (node: any) =>
      Object.assign({}, ...[node.props.style].flat(Infinity as 1)).bottom;
    expect(bottom(undo)).toBeGreaterThan(
      bottom(tree.root.findByProps({ testID: 'bookmark-undo' })),
    );
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await act(async () => undo.findByProps({ accessibilityRole: 'button' }).props.onPress());
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(scope9.ids(tree, /^needs-you-ask-\d$/)).toEqual(['needs-you-ask-1']);
    expect(scope9.calls('clearNeedsYouSection')).toEqual([]);
  });
});
