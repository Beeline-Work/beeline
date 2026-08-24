import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { deriveRoomUpdates, ROOM_UPDATE_DIGEST_MAX_CHARS, roomUpdateLine } from './room-updates';

const roomId = 'room';
const alan = 'a'.repeat(64);
const clara = 'c'.repeat(64);

function event(
  id: string,
  kind: number,
  created_at: number,
  tags: string[][],
  content = '',
  pubkey = alan,
): NostrEvent {
  return { id, kind, created_at, tags, content, pubkey, sig: 'sig' };
}

describe('room updates', () => {
  it('derives membership notices and coalesces a one-minute flap to nothing', () => {
    const updates = deriveRoomUpdates(
      roomId,
      [
        event('human-join', 9000, 10, [
          ['h', roomId],
          ['p', alan],
        ]),
        event('agent-seat', 9000, 20, [
          ['h', roomId],
          ['p', clara],
        ]),
        event('flap-join', 9000, 100, [
          ['h', roomId],
          ['p', 'f'],
        ]),
        event('flap-leave', 9001, 159, [
          ['h', roomId],
          ['p', 'f'],
        ]),
      ],
      new Set([clara]),
    );

    expect(
      updates.map((update) =>
        roomUpdateLine(update, (key) => (key === alan ? 'Alan' : key === clara ? 'Clara' : 'Flap')),
      ),
    ).toEqual(['○ Alan joined', '△ Clara seated by Alan']);
  });

  it('derives canonical corner history and only enriches its merge from legacy records', () => {
    const digest =
      'Implemented room updates from relay structure with focused regression coverage.';
    const events = [
      event('create', 9007, 10, [
        ['h', 'corner'],
        ['parent', roomId],
        ['task', 'Build quiet room updates'],
      ]),
      event('open', 30078, 11, [
        ['h', roomId],
        ['d', 'buzz-corner-state:corner'],
        ['t', 'buzz-corner-state'],
        ['state', 'open'],
      ]),
      event('working', 30078, 12, [
        ['h', roomId],
        ['d', 'buzz-corner-state:corner'],
        ['t', 'buzz-corner-state'],
        ['state', 'working'],
      ]),
      event('review', 30078, 20, [
        ['h', roomId],
        ['d', 'buzz-corner-state:corner'],
        ['t', 'buzz-corner-state'],
        ['state', 'waiting'],
        ['reason', 'review'],
      ]),
      event(
        'land',
        9,
        30,
        [
          ['h', roomId],
          ['t', 'land-summary'],
          ['subchannel', 'corner'],
          ['branch', 'refs/heads/main'],
          ['tip', '1234567890abcdef'],
        ],
        `Set out to: updates\nLanded: ${digest}.`,
      ),
      event('concluded', 30078, 31, [
        ['h', roomId],
        ['d', 'buzz-corner-state:corner'],
        ['t', 'buzz-corner-state'],
        ['state', 'concluded'],
      ]),
      event('closed', 30078, 32, [
        ['h', roomId],
        ['d', 'buzz-corner-state:corner'],
        ['t', 'buzz-corner-state'],
        ['state', 'closed'],
      ]),
      // A body-control open/close pair is deliberately not lifecycle authority.
      event('legacy-open', 9, 8, [
        ['h', roomId],
        ['t', 'body-control'],
        ['subchannel', 'other'],
        ['status', 'working'],
      ]),
      event('legacy-close', 9, 40, [
        ['h', roomId],
        ['t', 'body-control'],
        ['subchannel', 'other'],
        ['status', 'archived'],
      ]),
    ];

    const updates = deriveRoomUpdates(roomId, events, new Set());
    expect(updates.map((update) => roomUpdateLine(update, () => ''))).toEqual([
      '⌗ corner opened — Build quiet room…',
      '⌗ corner reported back',
      '⌗ merged → main @ 12345678',
      '⌗ corner closed',
    ]);
    expect(updates.find((update) => update.kind === 'corner-merged')?.digest).toBe(digest);
    expect(updates.every((update) => update.cornerId !== 'other')).toBe(true);
  });

  it('reconstructs a closed historical corner from the newest replaceable state', () => {
    const updates = deriveRoomUpdates(
      roomId,
      [
        event('create', 9007, 10, [
          ['h', 'corner'],
          ['parent', roomId],
          ['task', 'Ship the timeline'],
        ]),
        event(
          'land',
          9,
          20,
          [
            ['h', roomId],
            ['t', 'merge-summary'],
            ['subchannel', 'corner'],
            ['branch', 'main'],
            ['tip', 'abcdef0123456789'],
          ],
          'Merge summary\n\nAdded the derived timeline without new relay writes.',
        ),
        event('latest-only', 30078, 21, [
          ['h', roomId],
          ['d', 'buzz-corner-state:corner'],
          ['t', 'buzz-corner-state'],
          ['state', 'closed'],
        ]),
        event(
          'forged',
          30078,
          22,
          [
            ['h', roomId],
            ['d', 'buzz-corner-state:corner'],
            ['t', 'buzz-corner-state'],
            ['state', 'working'],
          ],
          '',
          'f'.repeat(64),
        ),
      ],
      new Set(),
    );

    expect(updates.map((update) => roomUpdateLine(update, () => ''))).toEqual([
      '⌗ corner opened — Ship the timeline',
      '⌗ corner reported back',
      '⌗ merged → main @ abcdef01',
      '⌗ corner closed',
    ]);
    expect(updates[2]?.digest).toBe('Added the derived timeline without new relay writes.');
  });

  it('derives changed Room facts without repeating unchanged metadata', () => {
    const updates = deriveRoomUpdates(
      roomId,
      [
        event('create', 9007, 1, [
          ['h', roomId],
          ['name', 'Roadmap'],
          ['visibility', 'open'],
        ]),
        event('rename', 9002, 2, [
          ['h', roomId],
          ['name', 'Launch room'],
        ]),
        event('same-name-private', 9002, 3, [
          ['h', roomId],
          ['name', 'Launch room'],
          ['visibility', 'private'],
        ]),
        event('picture', 9002, 4, [
          ['h', roomId],
          ['picture', 'https://example.com/room.png'],
        ]),
        event(
          'repo',
          30078,
          5,
          [
            ['h', roomId],
            ['d', `buzz-room-repository:${roomId}`],
            ['t', 'buzz-room-repository'],
          ],
          JSON.stringify({ key: 'github:acme/repo' }),
        ),
      ],
      new Set(),
    );

    expect(updates.map((update) => roomUpdateLine(update, () => ''))).toEqual([
      '▢ renamed to Launch room',
      '▢ set to invite-only',
      '▢ picture set',
      '▢ repository linked',
    ]);
  });

  it('caps the existing merge digest without generating new prose', () => {
    const long = 'x'.repeat(ROOM_UPDATE_DIGEST_MAX_CHARS + 20);
    const updates = deriveRoomUpdates(
      roomId,
      [
        event('create', 9007, 0, [
          ['h', 'corner'],
          ['parent', roomId],
        ]),
        event(
          'summary',
          9,
          1,
          [
            ['h', roomId],
            ['t', 'merge-summary'],
            ['subchannel', 'corner'],
            ['tip', 'f'.repeat(40)],
          ],
          `Merge summary\n\n${long}`,
        ),
        event('concluded', 30078, 2, [
          ['h', roomId],
          ['d', 'buzz-corner-state:corner'],
          ['t', 'buzz-corner-state'],
          ['state', 'concluded'],
        ]),
      ],
      new Set(),
    );
    const digest = updates.find((update) => update.kind === 'corner-merged')?.digest;
    expect(digest).toHaveLength(ROOM_UPDATE_DIGEST_MAX_CHARS);
    expect(digest?.endsWith('…')).toBe(true);
  });
});
