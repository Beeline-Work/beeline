import { describe, expect, it } from 'vitest';
import { buildActivityTimeline, buildTurnActivity } from './activity-timeline';

describe('buildActivityTimeline', () => {
  it('keeps a thinking firehose as one quiet progress item', () => {
    expect(
      buildActivityTimeline([
        { kind: 'thinking', title: 'Thinking', text: '**Planning platform detection**' },
        { kind: 'thinking', title: 'Thinking', text: 'Checking the runtime surface.' },
        { kind: 'thinking', title: 'Thinking', text: '**Implementing compact actions**' },
      ]),
    ).toEqual([
      {
        kind: 'reasoning',
        title: 'Implementing compact actions',
        detail:
          '**Planning platform detection**\nChecking the runtime surface.\n**Implementing compact actions**',
        count: 3,
      },
    ]);
  });

  it('turns tool plumbing into readable, collapsed actions', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'Tool', status: 'in_progress' },
        {
          kind: 'tool',
          title: 'grep "isChannelWorkIntent"',
          status: 'completed',
          text: '12 matches',
        },
        { kind: 'tool', title: 'Read /home/buzzy/apps/mobile/a.tsx', status: 'completed' },
        { kind: 'tool', title: 'Read /home/buzzy/apps/mobile/b.tsx', status: 'completed' },
        {
          kind: 'tool',
          title: 'bash: git status',
          status: 'completed',
          text: 'exited with code 0',
        },
      ]),
    ).toEqual([
      {
        kind: 'action',
        title: 'Searched the code for isChannelWorkIntent',
        count: 1,
      },
      {
        kind: 'action',
        title: 'Reviewed 2 files',
        count: 2,
      },
      {
        kind: 'action',
        title: 'Reviewed the current changes',
        count: 1,
      },
    ]);
  });

  it('turns failures into a human explanation and redacts full paths from details', () => {
    expect(
      buildActivityTimeline([
        {
          kind: 'tool',
          title: 'Code search',
          status: 'failed',
          text: 'Code search unavailable at /home/buzzy/.codegraph/index.db',
        },
      ]),
    ).toEqual([
      {
        kind: 'action',
        title: 'Code search unavailable',
        count: 1,
      },
    ]);
  });

  it('never surfaces a bare tool label or raw command output', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'Tool', status: 'completed', text: 'npm install --ignore-scripts' },
        { kind: 'tool', title: 'bash: pnpm lint', status: 'completed', text: 'All checks passed.' },
      ]),
    ).toEqual([
      { kind: 'action', title: 'Completed an action', count: 1 },
      { kind: 'action', title: 'Completed a project task', count: 1 },
    ]);
  });

  it('folds a repeated action into its first row even across other actions between them', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'bash: git status', status: 'completed' },
        { kind: 'tool', title: 'grep "foo"', status: 'completed' },
        { kind: 'tool', title: 'bash: git status', status: 'completed' },
        { kind: 'tool', title: 'Read /a.tsx', status: 'completed' },
        { kind: 'tool', title: 'bash: git status', status: 'completed' },
      ]),
    ).toEqual([
      { kind: 'action', title: 'Reviewed the current changes', count: 3 },
      { kind: 'action', title: 'Searched the code for foo', count: 1 },
      { kind: 'action', title: 'Reviewed a.tsx', count: 1 },
    ]);
  });
});

describe('buildTurnActivity', () => {
  it('omits reasoning, collapses duplicate tool updates, and exposes file/tool drill-downs', () => {
    expect(
      buildTurnActivity([
        { kind: 'thinking', title: 'Thinking', text: 'Internal narration' },
        {
          kind: 'tool',
          id: 'edit-1',
          title: 'Edit files',
          toolKind: 'edit',
          status: 'in_progress',
          files: [{ path: 'apps/mobile/chat.tsx' }],
        },
        {
          kind: 'tool',
          id: 'edit-1',
          title: 'Edit files',
          toolKind: 'edit',
          status: 'completed',
          output: 'Applied patch',
          files: [{ path: 'apps/mobile/chat.tsx', diff: '+new line' }],
        },
        {
          kind: 'tool',
          id: 'test-1',
          title: 'Run tests',
          command: 'npm test',
          output: '12 passed',
        },
      ]),
    ).toMatchObject({
      summary: 'Edited 1 file, ran tests.',
      updates: [],
      actions: [
        { kind: 'file', path: 'apps/mobile/chat.tsx', diff: '+new line' },
        { kind: 'tool', id: 'edit-1', output: 'Applied patch' },
        { kind: 'tool', id: 'test-1', command: 'npm test', output: '12 passed' },
      ],
    });
  });

  it('keeps only natural-language progress in the transcript and a stable checklist', () => {
    expect(
      buildTurnActivity([
        { kind: 'output', title: 'Update', text: 'Found the projection boundary.' },
        {
          kind: 'tool',
          id: 'plan-1',
          title: 'Update plan',
          plan: {
            items: [
              { step: 'Trace projection', status: 'completed' },
              { step: 'Build drill-down', status: 'in_progress' },
            ],
          },
        },
      ]),
    ).toMatchObject({
      updates: ['Found the projection boundary.'],
      plan: {
        items: [
          { step: 'Trace projection', status: 'completed' },
          { step: 'Build drill-down', status: 'in_progress' },
        ],
      },
    });
  });
});
