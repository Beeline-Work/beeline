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
import { liveRoomRuns, pickRoomWorkflowRun, useRoomWorkflowRun } from './use-room-workflow-run';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';

it('CWM1: the latest handoff stays primary, including a live state named stuck', () => {
  const run = (fields: Partial<WorkflowRunSummaryView>): WorkflowRunSummaryView => ({
    runId: 'default', roomId: 'corner-multi', roomName: 'MM desk',
    workflowSlug: 'mm-desk-steer', description: '', state: 'scout', status: 'live',
    startedAt: 1, updatedAt: 1, viewerHolds: false, ...fields,
  });
  const runs = [
    run({ runId: 'recent-start', workflowSlug: 'macro-paper-desk', startedAt: 20, updatedAt: 20 }),
    run({ runId: '6afa8c98', state: 'stuck', startedAt: 10, updatedAt: 30 }),
    run({ runId: 'ended', status: 'done', updatedAt: 100 }),
    run({ runId: 'elsewhere', roomId: 'another-corner', updatedAt: 90 }),
    run({ runId: 'older-handoff', workflowSlug: 'feedback-triage', updatedAt: 15 }),
  ];
  expect(pickRoomWorkflowRun('corner-multi', runs)?.runId).toBe('6afa8c98');
  expect(liveRoomRuns('corner-multi', runs).map(run => run.runId))
    .toEqual(['6afa8c98', 'recent-start', 'older-handoff']);
  expect(runs[0].runId).toBe('recent-start');
  expect(pickRoomWorkflowRun('empty', runs)).toBeUndefined();
});
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

it('lists the corner\'s other live saved-workflow runs beside the one it names, any workflow', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  read.mockResolvedValue({
    workflows: [
      { runId: 'a', workflowSlug: 'mm-desk', roomId: 'corner-multi', status: 'live', updatedAt: 10, state: 's', description: '', roomName: '', startedAt: 0, viewerHolds: false, },
      { runId: 'b', workflowSlug: 'macro-paper-desk', roomId: 'corner-multi', status: 'live', updatedAt: 20, state: 's', description: '', roomName: '', startedAt: 0, viewerHolds: false, },
    ],
  } as any);
  let current: any;
  function Corner() { current = useRoomWorkflowRun('corner-multi'); return null; }
  let tree: any;
  try {
    await act(async () => { tree = create(<Corner />); });
    // The most-recent-activity run is named; the other workflow's live run is listed beside it.
    expect(current.workflow.runId).toBe('b');
    expect(current.otherLiveRuns.map((run: any) => run.runId)).toEqual(['a']);
  } finally { await act(async () => tree.unmount()); }
});

it('R12k: the chat surface carries the error and Retry inline without a modal', () => {
  const source = readFileSync(new URL('../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url), 'utf8');
  expect(source).not.toContain("Modal.alert('Workflow unavailable'");
  expect(source).toContain('workflowError={workflowError}');
  expect(source).toContain('onRetryWorkflow={retryWorkflow}');
});
