import { describe, expect, it } from 'vitest';
import { buildActivityTimeline } from './activity-timeline';

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
});
