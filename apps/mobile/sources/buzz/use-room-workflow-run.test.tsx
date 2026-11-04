import { expect, it, vi } from 'vitest';
import { liveRoomRuns, pickRoomWorkflowRun } from './use-room-workflow-run';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';

vi.mock('./use-surface-focus', () => ({ useSurfaceFocus: () => true }));
vi.mock('./router-resource', () => ({ useRoutedResource: vi.fn() }));

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
