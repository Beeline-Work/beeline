import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn(async () => ({ workflows: [] })));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: read }));
const wire = vi.hoisted(() => ({ listener: undefined as any }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async (_: unknown, listener: unknown) => { wire.listener = listener; return () => undefined; } }) }));
afterEach(() => { read.mockReset(); read.mockResolvedValue({ workflows: [] }); });
import { useCornerWorkflowRun } from './use-corner-workflow-run';
it('Reproduction R9a: focused corner opens with exactly one workflow read', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  function Corner() { useCornerWorkflowRun('corner-1'); return null; }
  let tree: any;
  try {
    await act(async () => { tree = create(<Corner />); });
    expect(read).toHaveBeenCalledTimes(1);
  } finally { await act(async () => tree.unmount()); }
});

it('R9-OBS-06: alerts once per failure streak, including after a successful empty list', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const alert = vi.fn();
  read.mockRejectedValue(new Error('offline'));
  function Corner() { useCornerWorkflowRun('corner-errors', alert); return null; }
  let tree: any;
  try {
    await act(async () => { tree = create(<Corner />); });
    await act(async () => wire.listener({ monolithLive: { type: 'subscribed', roomId: 'corner-errors' } }));
    let reject!: (error: Error) => void;
    read.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    for (let i = 0; i < 5; i++) {
      await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'corner-errors', reason: 'message' } }));
      await act(async () => reject(new Error('offline')));
    }
    expect(read).toHaveBeenCalledTimes(6);
    expect(alert).toHaveBeenCalledTimes(1);
    read.mockRejectedValue(new Error('offline')).mockResolvedValueOnce({ workflows: [] });
    await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'corner-errors', reason: 'message' } }));
    await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'corner-errors', reason: 'message' } }));
    expect(alert).toHaveBeenCalledTimes(2);
  } finally { await act(async () => tree.unmount()); }
});
