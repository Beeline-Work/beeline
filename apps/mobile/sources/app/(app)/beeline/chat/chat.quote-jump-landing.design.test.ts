import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { messageJumpHref } from '@/buzz/corner-navigation';
import { RoomSendPreview } from '@/buzz/room-send-list';

vi.mock('react-native', () => ({ FlatList: 'FlatList', View: 'View' }));

const message = (digit: string, createdAt: number): RoomViewMessage => ({
  id: digit.repeat(64),
  createdAt,
  text: digit,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

it.each(['quote', 'notification', 'bookmark', 'message-link'])(
  '%s reads a distant target into the window once',
  async (source) => {
    const target = message('b', 2);
    const route = messageJumpHref('room', target.id, `${source}:${target.id}`);
    const around = vi.fn(async (): Promise<RoomHistoryView> => ({
      roomId: 'room',
      messages: [message('a', 1), target, message('c', 3)],
    }));
    const history = vi.fn(async (): Promise<RoomHistoryView> => ({ roomId: 'room', messages: [] }));
    let state: ReturnType<typeof useRoomMessageStore>;
    function Probe() {
      state = useRoomMessageStore({
        roomId: route.params.channelId,
        recordScope: 'test-scope',
        tailMessages: [message('f', 6)],
        roomClient: { history, historyAround: around },
        enabled: true,
        initialVisibleCount: 1,
      });
      return React.createElement('Probe');
    }
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      state!.jumpTo(route.params.notificationMessageId);
    });
    expect(around).toHaveBeenCalledExactlyOnceWith('room', target.id);
    expect(history).not.toHaveBeenCalled();
    expect(state!.jump).toEqual({ messageId: target.id, status: 'ready' });
    expect(state!.rows.map((row) => row.id)).toContain(target.id);
    await act(async () => {
      renderer!.unmount();
    });
  },
);

describe('message-source landing', () => {
  const surface = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

  it('never covers the room while a target loads', () => {
    expect(surface).not.toContain('Locating message');
    expect(surface).not.toContain('message-source-locating');
    expect(surface).not.toContain('isLocatingMessageSource');
  });

  it('lands with one scroll to the top of the screen, without estimated offsets or timers', () => {
    expect(surface).toContain(
      'requestMessageJump(scrollController, messageId, needsRead ? jumpToTranscriptMessage : null);',
    );
    const controller = readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'buzz', 'transcript-scroll-controller.ts'),
      'utf8',
    );
    // Top of the screen on the inverted phone list.
    expect(controller).toContain("viewPosition: align === 'top' ? 1 : 0.5");
    expect(controller).not.toContain('setTimeout');
    // A row the list has not measured yet is reached through an estimated
    // scroll near it, then one exact scroll on the next pass.
    expect(controller).toContain('if (!list.toRow(index, rowId, align)) {');
    expect(controller).toContain('list.toEstimatedRow(index);');
    expect(surface).toContain('onScrollToIndexFailed={phoneScrollList.scrollToIndexFailed}');
  });

  // Reproduction W1: the flash started at the first scroll and ran out while
  // the list was still measuring, before the row reached the screen.
  it('flashes the target when it lands, not when the list first scrolls', () => {
    const scrolled = surface.slice(
      surface.indexOf('onScrolled: ('),
      surface.indexOf('onLanded: ('),
    );
    const landed = surface.slice(surface.indexOf('onLanded: ('), surface.indexOf('onCancelled: ('));
    expect(scrolled).not.toContain('raiseSourceLandingFlash');
    expect(landed).toContain(
      "if (destination.kind === 'message' && destination.jump) raiseSourceLandingFlash(rowId);",
    );
  });

  it('measures a new window from scratch and lands again when the list measures a row', () => {
    expect(surface).toContain(
      'const phoneRowKey = (rowId: string) => `${transcriptWindowIdRef.current}:${sendPreviewRef.current.key(rowId)}`;',
    );
    expect(surface).toContain('keyExtractor={(item: ChatDisplayMessage) => phoneRowKey(item.id)}');
    expect(surface).toContain('CellRendererComponent={PhoneTranscriptCell}');
    expect(surface).toContain(
      'if (scrollController.isLanding()) scrollController.observeLayout();',
    );
  });

  it('keeps signed sends on their provisional key and namespaces every row by window', () => {
    // Execute the screen's actual key function with the real handoff owner.
    const parsed = ts.createSourceFile(
      'chat.tsx',
      surface,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let initializer = '';
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'phoneRowKey') {
        initializer = node.initializer?.getText(parsed) ?? '';
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    if (!initializer) throw new Error('The screen has no phoneRowKey function');
    const executable = ts.transpileModule(`(${initializer})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const preview = new RoomSendPreview();
    const window = { current: 7 };
    const key = runInNewContext(executable, {
      transcriptWindowIdRef: window,
      sendPreviewRef: { current: preview },
    }) as (rowId: string) => string;
    try {
      void preview.show({ id: 'provisional', text: 'Outgoing', timestamp: 1, isUser: true });
      const provisionalKey = key('provisional');
      expect(provisionalKey).toBe('7:provisional');
      preview.reconcile('provisional', 'signed');
      expect(key('signed')).toBe(provisionalKey);
      expect(key('ordinary')).toBe('7:ordinary');
      window.current = 8;
      expect(key('signed')).toBe('8:provisional');
      expect(key('ordinary')).toBe('8:ordinary');
    } finally {
      preview.dispose();
    }
  });
});
