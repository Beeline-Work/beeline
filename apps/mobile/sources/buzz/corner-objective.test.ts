import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import {
  cornerObjectiveFromSessionEvent,
  cornerObjectiveProgress,
  cornerObjectiveStepPresentation,
} from './corner-objective';

const agent = 'b'.repeat(64);

function objectiveEvent(
  body: { objective: string; steps?: Array<{ content: string; status?: string }> },
  createdAt: number,
  overrides: { pubkey?: string; agentTag?: string } = {},
): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'corner-1',
    payload: {
      id: `objective-${createdAt}`,
      content: JSON.stringify(body),
      pubkey: overrides.pubkey ?? agent,
      createdAt,
      tags: [
        ['h', 'corner-1'],
        ['d', 'corner-objective:corner-1'],
        ['t', 'corner-objective'],
        ['agent', overrides.agentTag ?? overrides.pubkey ?? agent],
      ],
    },
  };
}

describe('mobile corner objective projection', () => {
  it('projects the objective and plan checklist, defaulting a missing status to pending', () => {
    expect(
      cornerObjectiveFromSessionEvent(
        objectiveEvent(
          {
            objective: 'Fix the flaky test',
            steps: [
              { content: 'inspect the repo', status: 'completed' },
              { content: 'write the fix', status: 'in_progress' },
              { content: 'add tests' },
            ],
          },
          1_700_000_000,
        ),
      ),
    ).toEqual({
      agentPubkey: agent,
      objective: 'Fix the flaky test',
      steps: [
        { content: 'inspect the repo', status: 'completed' },
        { content: 'write the fix', status: 'in_progress' },
        { content: 'add tests', status: 'pending' },
      ],
      observedAt: 1_700_000_000_000,
    });
  });

  it('projects an objective-only banner (no plan yet) with an empty checklist', () => {
    expect(cornerObjectiveFromSessionEvent(objectiveEvent({ objective: 'Working on this corner.' }, 1)))
      .toEqual({
        agentPubkey: agent,
        objective: 'Working on this corner.',
        steps: [],
        observedAt: 1_000,
      });
  });

  it('rejects an event whose agent tag does not match the signing pubkey', () => {
    expect(
      cornerObjectiveFromSessionEvent(
        objectiveEvent({ objective: 'spoofed' }, 1, { agentTag: 'c'.repeat(64) }),
      ),
    ).toBeUndefined();
  });

  it('rejects an event missing the corner-objective marker tag', () => {
    const event: SessionEvent = {
      type: 'raw',
      sessionId: 'corner-1',
      payload: {
        id: 'not-an-objective',
        content: JSON.stringify({ objective: 'hi' }),
        pubkey: agent,
        createdAt: 1,
        tags: [
          ['h', 'corner-1'],
          ['agent', agent],
        ],
      },
    };
    expect(cornerObjectiveFromSessionEvent(event)).toBeUndefined();
  });

  it('rejects malformed JSON content and a missing objective string', () => {
    expect(cornerObjectiveFromSessionEvent(objectiveEvent({} as { objective: string }, 1))).toBeUndefined();
    const event = objectiveEvent({ objective: 'x' }, 1);
    (event.payload as { content: string }).content = 'not-json';
    expect(cornerObjectiveFromSessionEvent(event)).toBeUndefined();
  });
});

describe('cornerObjectiveStepPresentation', () => {
  it('renders a completed step struck through', () => {
    expect(cornerObjectiveStepPresentation({ content: 'done', status: 'completed' })).toEqual({
      glyph: '✓',
      struckThrough: true,
    });
  });

  it('renders in-progress and pending steps without strikethrough', () => {
    expect(cornerObjectiveStepPresentation({ content: 'doing', status: 'in_progress' })).toEqual({
      glyph: '▸',
      struckThrough: false,
    });
    expect(cornerObjectiveStepPresentation({ content: 'todo', status: 'pending' })).toEqual({
      glyph: '○',
      struckThrough: false,
    });
  });
});

describe('cornerObjectiveProgress', () => {
  it('counts completed steps against the total', () => {
    expect(
      cornerObjectiveProgress([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
      ]),
    ).toEqual({ done: 2, total: 3 });
  });

  it('handles an empty checklist', () => {
    expect(cornerObjectiveProgress([])).toEqual({ done: 0, total: 0 });
  });
});
