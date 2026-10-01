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
  it('marks corners the viewer commissioned or that await them', () => {
    const result = chatCornerCounts([
      { ...row(), commissioned_by_viewer: true },
      { ...row({ reason: 'question' }), latest_tags_viewer: true },
      { ...row({}, 'working'), latest_tags_viewer: true },
      row({ reason: 'question' }),
    ]);
    expect(result.get('room')?.openCorners.map((corner) => corner.mine)).toEqual([
      true,
      true,
      undefined,
      undefined,
    ]);
  });
  it('reads idle with nothing owed and flags only unseen asks for the viewer', () => {
    const result = chatCornerCounts([
      { ...row(), commissioned_by_viewer: true, owed: false, owed_viewer: false, attention: false },
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
      { ...row(), commissioned_by_viewer: true, latest_created_at: at },
      { ...row({}, 'working'), commissioned_by_viewer: true, latest_created_at: at },
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
            openCorners: [{ id: 'corner', name: 'Corner', state: 'waiting' }],
          },
        ],
      ]),
    );
  });
});
