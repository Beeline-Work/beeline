import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn(async () => ({ workflows: [] })));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: read }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async () => () => undefined }) }));
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
