import { describe, it, expect } from 'vitest';
import { chatCornerCounts } from './chat-corner-counts.js';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
const row = (
  lifecycle: Partial<CornerLifecycleView> = {},
  latest_turn_status: string | null = null,
) => ({
  parent_id: 'room',
  archived_at: null,
  lifecycle: { lifecycle: 'open', checks: 'unknown', ...lifecycle } as CornerLifecycleView,
  latest_turn_status,
});
describe('chat corner counts', () => {
  it('counts canonical waiting separately from working and review', () => {
    const result = chatCornerCounts([
      row({ reason: 'question' }),
      row({ reason: 'failed' }),
      row({}, 'working'),
      row({ pr: { url: 'https://github.com/example/repo/pull/1', number: 1 } } as any),
    ]);
    expect(result.get('room')).toEqual({ cornerCount: 4, waitingCornerCount: 2 });
  });
  it('excludes terminal lifecycle even before archived_at is projected', () => {
    expect(
      chatCornerCounts([
        row({ lifecycle: 'done' }),
        row({ outcome: 'landed' }),
        { ...row(), archived_at: new Date() },
        { ...row(), parent_id: 'another' },
      ]),
    ).toEqual(new Map([['another', { cornerCount: 1, waitingCornerCount: 1 }]]));
  });
});
