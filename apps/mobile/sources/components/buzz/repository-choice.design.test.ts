import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';

/**
 * The open Repository row on the Room sheet and New Room. Its label once
 * shrank to a grey field label and its switch wore the black/white primary
 * fill on a paler track; the org header in the repo list sat in a pale band.
 */
const choice = readFileSync(new URL('./RepositoryChoice.tsx', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('./IndexRow.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('./RoomListSectionHeader.tsx', import.meta.url), 'utf8');
const repoList = readFileSync(new URL('./RepoList.tsx', import.meta.url), 'utf8');

function styleBody(source: string, name: string): string {
  const match = source.match(new RegExp(`\\n\\s+${name}: \\{([^}]*)\\}`));
  expect(match, `missing style ${name}`).not.toBeNull();
  return match![1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join(' ');
}

describe('open Repository row', () => {
  it('keeps the label in the same type as the other sheet row labels', () => {
    const label = styleBody(choice, 'fieldLabel');
    for (const part of ['...Typography.default()', '...hull.type.body', 'color: hull.textPrimary'])
      expect(label).toContain(part);
    for (const part of ['...Typography.default()', '...hull.type.body', 'color: hull.textPrimary'])
      expect(styleBody(sheet, 'title')).toContain(part);
  });

  it('sits inside one row frame with the closed row height', () => {
    expect(styleBody(choice, 'labelLine')).toContain('minHeight: 52 - 2 * hull.space.sm');
    expect(HULL_SHEET_ROW_HEIGHT).toBe(52);
    expect(styleBody(sheet, 'sheetRow')).toContain('minHeight: HULL_SHEET_ROW_HEIGHT');
    expect(styleBody(sheet, 'sheetRow')).toContain('paddingVertical: hull.space.sm');
    const block = styleBody(choice, 'repoBlock');
    expect(block).toContain('paddingVertical: hull.space.sm');
    expect(block).toContain('borderTopColor: hull.border');
  });

  it('marks the selected segment quietly, with no primary fill and no track band', () => {
    const selected = `${styleBody(choice, 'segmentSelected')} ${styleBody(choice, 'segmentTextSelected')}`;
    expect(selected).not.toMatch(/buttonPrimary(Fill|Text)/);
    expect(selected).toContain('backgroundColor: hull.bgHighlight');
    expect(selected).toContain('borderColor: hull.borderStrong');
    expect(selected).toContain('color: hull.textPrimary');
    expect(styleBody(choice, 'segmentTextSelected')).toContain("Typography.default('semiBold')");
    expect(styleBody(choice, 'segments')).not.toContain('backgroundColor');
  });

  it('draws no box around the repo picker', () => {
    expect(styleBody(choice, 'repoRow')).not.toContain('borderWidth');
  });
});

describe('section header on a sheet', () => {
  it('takes the sheet surface instead of the screen fill', () => {
    expect(styleBody(header, 'sectionHeader')).toContain('backgroundColor: hull.bgTerminal');
    expect(styleBody(header, 'sheetSurface')).toContain("backgroundColor: 'transparent'");
    expect(repoList).toMatch(/<RoomListSectionHeader[^>]*surface="sheet"/);
    expect(repoList).toContain('stickySectionHeadersEnabled={false}');
  });
});
