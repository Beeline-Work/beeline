import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async () => () => undefined }) }));
vi.mock('@/buzz/workbench-source', () => ({ getWorkbenchSource: vi.fn() }));

vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));

import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { pickRoomWorkflowRun } from '@/buzz/use-room-workflow-run';


const run = (overrides: Partial<WorkflowRunSummaryView>): WorkflowRunSummaryView => ({
  runId: 'run',
  workflowSlug: 'corner',
  description: 'd',
  roomId: 'corner-1',
  roomName: 'Issues triage',
  state: 'implement',
  status: 'live',
  viewerHolds: false,
  startedAt: 1,
  updatedAt: 1,
  earlierRunCount: 0,
  ...overrides,
});

describe('corner workflow line', () => {

  it('shows only live saved workflows, including one someone named corner', () => {
    const saved = run({ runId: 'saved-corner-workflow' });
    expect(pickRoomWorkflowRun('corner-1', [saved])).toBe(saved);
    expect(pickRoomWorkflowRun('corner-1', [])).toBeUndefined();
    expect(pickRoomWorkflowRun('corner-1', [run({ status: 'done' })])).toBeUndefined();
    expect(pickRoomWorkflowRun('corner-1', [run({ roomId: 'other' })])).toBeUndefined();
  });
});
