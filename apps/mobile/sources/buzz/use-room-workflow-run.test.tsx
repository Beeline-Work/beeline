import { readFileSync } from 'node:fs';
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
import { useRoomWorkflowRun } from './use-room-workflow-run';
it('Reproduction R9a: focused corner opens with exactly one workflow read', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  function Corner() { useRoomWorkflowRun('corner-1'); return null; }
  let tree: any;
  try {
    await act(async () => { tree = create(<Corner />); });
    expect(read).toHaveBeenCalledTimes(1);
  } finally { await act(async () => tree.unmount()); }
});


it('R12k: exposes an inline error and Retry recovers the workflow read', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  read.mockRejectedValue(new Error('offline'));
  let current: any;
  function Corner() { current = useRoomWorkflowRun('corner-errors'); return <span>{current.error}</span>; }
  let tree: any;
  try {
    await act(async () => { tree = create(<Corner />); });
    expect(current.error).toBe('offline');
    read.mockRejectedValue(new Error('second failure'));
    await act(async () => current.retry());
    expect(current.error).toBe('offline');
    read.mockResolvedValue({ workflows: [] });
    await act(async () => current.retry());
    expect(current.error).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  } finally { await act(async () => tree.unmount()); }
});

it('R12k: the chat surface carries the error and Retry inline without a modal', () => {
  const source = readFileSync(new URL('../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url), 'utf8');
  expect(source).not.toContain("Modal.alert('Workflow unavailable'");
  expect(source).toContain('workflowError={workflowError}');
  expect(source).toContain('onRetryWorkflow={retryWorkflow}');
});
