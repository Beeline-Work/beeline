import { describe, expect, it } from 'vitest';
import { projectEvent } from './room-indexer-projection.js';

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
