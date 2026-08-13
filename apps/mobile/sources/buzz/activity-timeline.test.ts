import { describe, expect, it } from 'vitest';
import { buildActivityTimeline } from './activity-timeline';

describe('buildActivityTimeline', () => {
  it('collapses a thinking firehose into one quiet phase row', () => {
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

  it('coalesces adjacent tool updates and surfaces only useful result metadata', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'grep "isChannelWorkIntent"', status: 'in_progress' },
        {
          kind: 'tool',
          title: 'grep "isChannelWorkIntent"',
          status: 'completed',
          text: '12 matches',
        },
        { kind: 'tool', title: 'bash', status: 'completed', text: 'exited with code 0' },
      ]),
    ).toEqual([
      {
        kind: 'action',
        title: 'grep "isChannelWorkIntent"',
        summary: '12 matches',
        detail: '12 matches',
        status: 'completed',
      },
      {
        kind: 'action',
        title: 'bash',
        summary: 'exit 0',
        detail: 'exited with code 0',
        status: 'completed',
      },
    ]);
  });
});
