import { describe, expect, it } from 'vitest';
import type { CornerListItem } from '@beeline/buzz-client';
import {
  INSPECTOR_CORNER_LIST_CAP,
  inspectorCornerObjective,
  inspectorCornerOverflowLabel,
  inspectorCornerWindow,
} from './inspector-corners';

function corner(id: string, state: CornerListItem['state'], name = id): CornerListItem {
  return {
    corner: {
      id,
      workspaceId: 'workspace',
      name,
      archived: state === 'archived',
      createdAt: 1,
      updatedAt: 2,
    },
    lifecycle: { lifecycle: state === 'archived' ? 'done' : 'active', checks: 'unknown' },
    state,
    stateAt: 2,
  } as CornerListItem;
}

describe('inspectorCornerObjective', () => {
  it('returns the distinct objective and hides a missing or duplicate line', () => {
    expect(
      inspectorCornerObjective(
        'Desktop Update Diagnosis',
        'Find why desktop update stalls after the helper probe.',
      ),
    ).toBe('Find why desktop update stalls after the helper probe.');
    expect(inspectorCornerObjective('Desktop Update Diagnosis', undefined)).toBeUndefined();
    expect(inspectorCornerObjective('Desktop Update Diagnosis', '   ')).toBeUndefined();
    expect(
      inspectorCornerObjective('Desktop Update Diagnosis', 'Desktop Update Diagnosis'),
    ).toBeUndefined();
    expect(
      inspectorCornerObjective('Desktop Update Diagnosis', 'desktop update diagnosis'),
    ).toBeUndefined();
  });

  it('keeps a longer objective whose first words match the title', () => {
    expect(
      inspectorCornerObjective(
        'Rework the room',
        'Rework the room list so every corner row carries a state mark',
      ),
    ).toBe('Rework the room list so every corner row carries a state mark');
  });
});

describe('inspectorCornerWindow', () => {
  it('caps the live list at five and names archived overflow separately', () => {
    expect(INSPECTOR_CORNER_LIST_CAP).toBe(5);
    const corners = [
      ...Array.from({ length: 8 }, (_, index) => corner(`live-${index}`, 'working')),
      corner('done', 'archived'),
    ];
    const collapsed = inspectorCornerWindow(corners, false);
    expect(collapsed.visible.map((item) => item.corner.id)).toEqual([
      'live-0',
      'live-1',
      'live-2',
      'live-3',
      'live-4',
    ]);
    expect(collapsed.overflowLabel).toBe('4 more');
    expect(inspectorCornerWindow(corners, true).visible).toHaveLength(9);
  });

  it('shows archived corners when none are active, instead of an empty live list', () => {
    const archived = [
      corner('done-1', 'archived'),
      corner('done-2', 'archived'),
      corner('done-3', 'archived'),
    ];
    const collapsed = inspectorCornerWindow(archived, false);
    expect(collapsed.visible.map((item) => item.corner.id)).toEqual([
      'done-1',
      'done-2',
      'done-3',
    ]);
    expect(collapsed.overflowLabel).toBeNull();
  });

  it('caps a long archived-only list and expands the rest', () => {
    const archived = Array.from({ length: 7 }, (_, index) => corner(`done-${index}`, 'archived'));
    const collapsed = inspectorCornerWindow(archived, false);
    expect(collapsed.visible).toHaveLength(5);
    expect(collapsed.overflowLabel).toBe('2 more');
    expect(inspectorCornerWindow(archived, true).visible).toHaveLength(7);
  });

  it('keeps archived behind the existing archived · N row while live work is showing', () => {
    const corners = [corner('live', 'working'), corner('done', 'archived')];
    const collapsed = inspectorCornerWindow(corners, false);
    expect(collapsed.visible.map((item) => item.corner.id)).toEqual(['live']);
    expect(collapsed.overflowLabel).toBe('archived · 1');
  });
});

describe('inspectorCornerOverflowLabel', () => {
  it('uses archived · N only when live rows are showing and only archived remain', () => {
    expect(inspectorCornerOverflowLabel(0, 3, false)).toBe('archived · 3');
    expect(inspectorCornerOverflowLabel(2, 3, false)).toBe('5 more');
    expect(inspectorCornerOverflowLabel(0, 2, true)).toBe('2 more');
    expect(inspectorCornerOverflowLabel(0, 0, false)).toBeNull();
  });
});
