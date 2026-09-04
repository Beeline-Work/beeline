import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The section-head "+" (MembersScreen and the Room roster sheet) reads at
 * hull.type.hero, not the muted sectionHead caps its label sits in — it is
 * the one actionable glyph on the row. The 44pt target stays fixed so the
 * larger glyph never stretches the section-head row's height.
 */
const membersSource = readFileSync(
  path.join(__dirname, '../../app/(app)/beeline/MembersScreen.tsx'),
  'utf8',
);
const rosterSource = readFileSync(path.join(__dirname, './RoomRosterSheet.tsx'), 'utf8');

describe('Section-head "+" glyph', () => {
  it('draws MembersScreen’s add glyph at hero and keeps the target fixed at 44', () => {
    const glyph = membersSource.match(/sectionAddGlyph:\s*\{[^}]*\}/);
    expect(glyph, 'missing sectionAddGlyph style').toBeTruthy();
    expect(glyph![0]).toContain('...hull.type.hero');
    expect(glyph![0]).not.toContain('sectionHead');

    const target = membersSource.match(/sectionAdd:\s*\{[\s\S]*?\n\s*\},/);
    expect(target, 'missing sectionAdd style').toBeTruthy();
    expect(target![0]).toContain('width: 44');
    expect(target![0]).toContain('height: 44');
  });

  it('draws the roster sheet’s add glyph at hero and keeps the target fixed at 44', () => {
    const glyph = rosterSource.match(/rosterSectionAddGlyph:\s*\{[^}]*\}/);
    expect(glyph, 'missing rosterSectionAddGlyph style').toBeTruthy();
    expect(glyph![0]).toContain('...hull.type.hero');
    expect(glyph![0]).not.toContain('sectionHead');

    const target = rosterSource.match(/rosterSectionAdd:\s*\{[\s\S]*?\n\s*\},/);
    expect(target, 'missing rosterSectionAdd style').toBeTruthy();
    expect(target![0]).toContain('width: 44');
    expect(target![0]).toContain('height: 44');
  });
});
