import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));

import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { pickCornerWorkflowRun } from '@/buzz/use-corner-workflow-run';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');

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
  it('reads the corner’s live run and opens its run page, never drawing the graph in the corner', () => {
    expect(chat).toMatch(/useCornerWorkflowRun\(\s*isCorner \? decodedId : undefined,/);
    expect(chat).toContain('router.push(workflowRunHref(cornerWorkflowRun))');
    expect(chat).toMatch(
      /<CornerObjectiveLine[\s\S]*?onOpenWorkflow=\{openCornerWorkflowRun\}[\s\S]*?workflow=\{cornerWorkflowRun\}/,
    );
    expect(chat).not.toContain('WorkflowRunLine');
  });

  it('names a saved workflow working in the corner before the corner’s own lifecycle run', () => {
    const lifecycle = run({ runId: 'corner-1' });
    const triage = run({ runId: 'triage', workflowSlug: 'feedback-triage', state: 'approve' });
    expect(pickCornerWorkflowRun('corner-1', [lifecycle, triage])).toBe(triage);
    expect(pickCornerWorkflowRun('corner-1', [lifecycle])).toBe(lifecycle);
    expect(pickCornerWorkflowRun('corner-1', [run({ status: 'done' })])).toBeUndefined();
    expect(pickCornerWorkflowRun('corner-1', [run({ roomId: 'other' })])).toBeUndefined();
  });
});
