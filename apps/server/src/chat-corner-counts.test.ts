import { describe, it, expect } from 'vitest';
import { chatCornerCounts } from './chat-corner-counts.js';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
const row = (
  lifecycle: Partial<CornerLifecycleView> = {},
  latest_turn_status: string | null = null,
) => ({
  id: 'corner',
  name: 'Corner',
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
    expect(result.get('room')).toMatchObject({ cornerCount: 4, waitingCornerCount: 2 });
    expect(result.get('room')?.openCorners.map((corner) => corner.state)).toEqual([
      'waiting',
      'waiting',
      'working',
      'review',
    ]);
  });
  it('marks corners the viewer follows or that owe them something', () => {
    const result = chatCornerCounts([
      { ...row(), follows_viewer: true },
      { ...row({}, 'working'), follows_viewer: true },
      { ...row(), owed: true, owed_viewer: true },
      row({ reason: 'question' }),
    ]);
    expect(result.get('room')?.openCorners.map((corner) => corner.mine)).toEqual([
      true,
      true,
      true,
      undefined,
    ]);
  });
  it('marks a corner the viewer commissioned as Mine', () => {
    const result = chatCornerCounts([{ ...row(), commissioned_viewer: true }, row()]);
    expect(result.get('room')?.openCorners.map((corner) => corner.mine)).toEqual([true, undefined]);
    expect(result.get('room')?.mineCornerCount).toBe(1);
  });
  it('lists every Mine corner, fills to eight with the newest others, and counts exactly', () => {
    const corners = (prefix: string, length: number, mine: boolean) =>
      Array.from({ length }, (_, index) => ({ ...row(), id: `${prefix}-${index}`, follows_viewer: mine }));
    const few = chatCornerCounts([...corners('other', 10, false), ...corners('mine', 3, true)]).get('room');
    expect(few?.openCorners.map((corner) => corner.id)).toEqual([
      'other-0', 'other-1', 'other-2', 'other-3', 'other-4', 'mine-0', 'mine-1', 'mine-2',
    ]);
    expect(few).toMatchObject({ cornerCount: 13, mineCornerCount: 3 });
    const many = chatCornerCounts([...corners('other', 2, false), ...corners('mine', 9, true)]).get('room');
    expect(many?.openCorners.map((corner) => corner.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `mine-${index}`),
    );
    expect(many).toMatchObject({ cornerCount: 11, mineCornerCount: 9 });
  });
  it('reads idle with nothing owed and flags only unseen asks for the viewer', () => {
    const result = chatCornerCounts([
      { ...row(), follows_viewer: true, owed: false, owed_viewer: false, attention: false },
      { ...row(), owed: true, owed_viewer: true, attention: true },
      { ...row(), owed: true, owed_viewer: true, attention: false },
      { ...row({}, 'working'), owed: true, owed_viewer: true, attention: true },
    ]);
    expect(result.get('room')).toMatchObject({ cornerCount: 4, waitingCornerCount: 2 });
    expect(
      result.get('room')?.openCorners.map(({ state, mine, attention }) => [state, mine, attention]),
    ).toEqual([
      ['idle', true, undefined],
      ['waiting', true, true],
      ['waiting', true, undefined],
      ['working', true, undefined],
    ]);
  });
  it("stamps only the viewer's waiting corners with when they handed back", () => {
    const at = new Date('2026-09-29T12:00:00Z');
    const result = chatCornerCounts([
      { ...row(), follows_viewer: true, latest_created_at: at },
      { ...row({}, 'working'), follows_viewer: true, latest_created_at: at },
      { ...row(), latest_created_at: at },
    ]);
    expect(result.get('room')?.openCorners.map((corner) => corner.waitingSince)).toEqual([
      at.getTime() / 1000,
      undefined,
      undefined,
    ]);
  });
  it('excludes terminal lifecycle even before archived_at is projected', () => {
    expect(
      chatCornerCounts([
        row({ lifecycle: 'done' }),
        row({ outcome: 'landed' }),
        { ...row(), archived_at: new Date() },
        { ...row(), parent_id: 'another' },
      ]),
    ).toEqual(
      new Map([
        [
          'another',
          {
            cornerCount: 1,
            waitingCornerCount: 1,
            mineCornerCount: 0,
            openCorners: [{ id: 'corner', name: 'Corner', state: 'waiting' }],
          },
        ],
      ]),
    );
  });
});
