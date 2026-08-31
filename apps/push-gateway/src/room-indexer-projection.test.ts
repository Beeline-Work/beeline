import { describe, expect, it } from 'vitest';
import { cornerItem, projectEvent } from './room-indexer-projection.js';

describe('room event projection', () => {
  it('never renders daemon-authored kind:9 JSON documents as chat bubbles', () => {
    for (const [marker, payload] of [
      [
        'buzz-work-schedule-paused',
        { version: 1, scheduleId: 'harvest', status: 'paused', reason: 'invalid' },
      ],
      [
        'beeline-agent-tool-result',
        { schema_version: 3, tool: 'open_corner', status: 'executed' },
      ],
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

    expect(cornerItem({ ...data, latestTurnStatus: 'working' }).status).toBe('working');
    expect(cornerItem({ ...data, latestTurnStatus: 'complete' }).status).not.toBe('working');
    expect(cornerItem({ ...data, latestTurnStatus: 'failed' }).status).not.toBe('working');
  });
});
