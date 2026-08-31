import { describe, expect, it } from 'vitest';
import {
  cornerItem,
  latestCornerPlan,
  projectEvent,
  projectedRoomMessages,
} from './room-indexer-projection.js';

describe('room event projection', () => {
  it('never renders production-shaped Room join diagnostics as agent conversation', () => {
    expect(
      projectEvent(
        {
          id: 'legacy-room-join-notice',
          kind: 9,
          agent: true,
          pubkey: 'a'.repeat(64),
          createdAt: 1_777_000_000,
          tags: [
            ['h', '3f37b271-1a12-4d2a-b002-202b3f3582b9'],
            ['t', 'buzz-agent-room-join-notice'],
            ['status', 'repository-unavailable'],
          ],
          content:
            "Agent unavailable: I could not access this Room's repository. " +
            'I will retry automatically in 30 seconds.',
        },
        '3f37b271-1a12-4d2a-b002-202b3f3582b9',
      ),
    ).toBeUndefined();
  });

  it('never renders daemon-authored kind:9 JSON documents as chat bubbles', () => {
    for (const [marker, payload] of [
      [
        'buzz-work-schedule-paused',
        { version: 1, scheduleId: 'harvest', status: 'paused', reason: 'invalid' },
      ],
      ['beeline-agent-tool-result', { schema_version: 3, tool: 'open_corner', status: 'executed' }],
    ] as const) {
      expect(
        projectEvent(
          {
            id: marker,
            kind: 9,
            agent: true,
            pubkey: 'a'.repeat(64),
            createdAt: 1,
            tags: [
              ['h', 'room'],
              ['t', marker],
            ],
            content: JSON.stringify(payload),
          },
          'room',
        ),
      ).toBeUndefined();
    }
  });

  it('recovers legacy model prose from agent-activity history as conversation', () => {
    const projected = projectEvent(
      {
        id: 'legacy-model-output',
        kind: 9,
        agent: true,
        pubkey: 'a'.repeat(64),
        createdAt: 10,
        tags: [
          ['h', 'corner'],
          ['t', 'agent-activity'],
          ['session', 'legacy-session'],
        ],
        content: JSON.stringify({
          sessionId: 'legacy-session',
          update: {
            sessionUpdate: 'activity_batch',
            updates: [
              {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Earlier model ' },
              },
              {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'reply persists.' },
              },
            ],
          },
        }),
      },
      'corner',
    );

    expect(projected).toMatchObject({
      text: 'Earlier model reply persists.',
      presentation: 'message',
    });
  });

  it('keeps a branch-ended daemon fact visible as the parent Room summary', () => {
    expect(
      projectEvent(
        {
          id: 'corner-landed',
          kind: 9,
          agent: true,
          pubkey: 'a'.repeat(64),
          createdAt: 11,
          tags: [
            ['h', 'room'],
            ['t', 'daemon-fact'],
            ['t', 'corner-branch-ended'],
            ['subchannel', 'corner'],
            ['outcome', 'landed'],
          ],
          content: 'Landed “Smoke lifecycle PR” into main.',
        },
        'room',
      ),
    ).toMatchObject({
      text: 'Landed “Smoke lifecycle PR” into main.',
      presentation: 'system',
    });
  });

  it('keeps a completed corner worktree fact visible in the parent Room', () => {
    expect(
      projectEvent(
        {
          id: 'corner-worktree-cleaned',
          kind: 9,
          agent: true,
          pubkey: 'a'.repeat(64),
          createdAt: 12,
          tags: [
            ['h', 'room'],
            ['t', 'daemon-fact'],
            ['t', 'corner-worktree-cleaned'],
            ['subchannel', 'corner'],
          ],
          content: 'Corner worktree cleaned after branch deletion.',
        },
        'room',
      ),
    ).toMatchObject({
      text: 'Corner worktree cleaned after branch deletion.',
      presentation: 'system',
    });
  });

  it('keeps the completed plan durable while projecting current tool activity only live', () => {
    const row = {
      section: 'event',
      data: {
        id: 'completed-plan',
        kind: 9,
        agent: true,
        pubkey: 'a'.repeat(64),
        createdAt: 20,
        tags: [
          ['h', 'corner'],
          ['t', 'agent-activity'],
        ],
        content: JSON.stringify({
          sessionId: 'session',
          update: {
            sessionUpdate: 'activity_batch',
            updates: [
              {
                sessionUpdate: 'activity_summary',
                title: 'Updated plan',
                plan: {
                  objective: 'Keep every finished step',
                  items: [
                    { step: 'Recover history', status: 'completed' },
                    { step: 'Prove the lifecycle', status: 'completed' },
                  ],
                },
              },
            ],
          },
        }),
      },
    } as const;

    expect(latestCornerPlan([row], 'corner')).toEqual({
      objective: 'Keep every finished step',
      items: [
        { step: 'Recover history', status: 'completed' },
        { step: 'Prove the lifecycle', status: 'completed' },
      ],
    });
    expect(
      projectedRoomMessages([row], 'corner', [
        {
          requestId: 'request',
          agentPubkey: 'a'.repeat(64),
          status: 'complete',
          createdAt: 21,
        },
      ]),
    ).toEqual([]);
  });
});

describe('corner item projection', () => {
  it('maps only a working latest turn onto a WORKING lifecycle corner', () => {
    const data = {
      id: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
      workspaceId: 'ec08be9d-9d9d-413e-b546-959d4abe39df',
      parentId: '7d111868-52eb-43ab-98ae-8a6c49b92da8',
      name: 'Agent corner',
      visibility: 'open',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(
      cornerItem({ ...data, latestTurnStatus: 'working', latestTurnCreatedAt: 37 }),
    ).toMatchObject({ status: 'working', statusAt: 37 });
    expect(cornerItem({ ...data, latestTurnStatus: 'complete' }).status).not.toBe('working');
    expect(cornerItem({ ...data, latestTurnStatus: 'failed' }).status).not.toBe('working');
  });

  it('keeps an open PR non-actionable while a fresh steering receipt lights working', () => {
    const data = {
      id: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
      workspaceId: 'ec08be9d-9d9d-413e-b546-959d4abe39df',
      parentId: '7d111868-52eb-43ab-98ae-8a6c49b92da8',
      name: 'Review steering corner',
      visibility: 'open',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      remoteStateContent: JSON.stringify({
        version: 1,
        cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
        branch: 'feature/review-steering',
        state: 'in-review',
        checks: 'pending',
        observedAt: 40,
        pr: {
          number: 42,
          url: 'https://github.com/acme/beeline/pull/42',
          title: 'Ship it',
          targetBranch: 'main',
          headSha: '1'.repeat(40),
        },
      }),
    };

    expect(
      cornerItem({ ...data, latestTurnStatus: 'working', latestTurnCreatedAt: 41 }),
    ).toMatchObject({
      lifecycle: { lifecycle: 'in-review' },
      status: 'working',
      statusAt: 41,
    });
    expect(cornerItem({ ...data, latestTurnStatus: 'complete' })).toMatchObject({
      lifecycle: { lifecycle: 'in-review' },
      status: 'idle',
    });
  });
});
