import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { useRoomSendFrame } from './room-send-frame';

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

type Hook = ReturnType<typeof useRoomSendFrame>;

function Harness({
  committedIds,
  capture,
}: {
  committedIds: ReadonlySet<string>;
  capture(hook: Hook): void;
}) {
  capture(useRoomSendFrame([], committedIds));
  return null;
}

describe('Room send overlay', () => {
  it('never shows a sent row again after its committed row leaves the newest rows', async () => {
    const sent = { id: 'sent-row', text: 'hello' } as ChatDisplayMessage;
    let hook!: Hook;
    const capture = (next: Hook) => (hook = next);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness committedIds={new Set()} capture={capture} />);
    });
    await act(async () => hook.append([sent]));
    expect(hook.frame.optimistic.map((message) => message.id)).toEqual(['sent-row']);

    // The server commits the row into the newest rows.
    await act(async () => renderer.update(<Harness committedIds={new Set(['sent-row'])} capture={capture} />));
    expect(hook.frame.optimistic).toEqual([]);

    // Newer rows push it out of the newest rows; it now lives in history.
    await act(async () => renderer.update(<Harness committedIds={new Set(['newer-row'])} capture={capture} />));
    expect(hook.frame.optimistic).toEqual([]);
    await act(async () => renderer.unmount());
  });
});
