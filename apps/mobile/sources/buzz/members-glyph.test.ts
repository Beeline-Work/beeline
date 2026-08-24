import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cornerStatusPresentation, type CornerStatus } from './corners';
import { MEMBERS_GLYPH, MEMBERS_LABEL } from './vocabulary';

/**
 * Every surface that routes a person to the members screen, and the one glyph
 * they now share. Before this, the same destination was reached through three
 * different words and only one of them carried a mark at all.
 */
const MEMBERS_ENTRY_POINTS = [
  '../app/(app)/buzz/channels.tsx',
  '../app/(app)/buzz/MembersScreen.tsx',
  '../app/(app)/buzz/settings/workspace.tsx',
  '../components/buzz/CommunityInviteEntry.tsx',
];

const CORNER_STATUSES: CornerStatus[] = [
  'live',
  'needs-attention',
  'open',
  'failed',
  'merged',
  'archived',
];

describe('the members mark', () => {
  it('is one glyph, reached from every members entry point', () => {
    for (const relativePath of MEMBERS_ENTRY_POINTS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should import the shared members mark`).toContain(
        'MEMBERS_GLYPH',
      );
      // ...and no screen hardcodes the glyph or a competing word for it.
      expect(source, `${relativePath} hardcodes the members glyph`).not.toContain(
        `>${MEMBERS_GLYPH}<`,
      );
      expect(source, `${relativePath} still says PEOPLE`).not.toMatch(/>\s*PEOPLE\s*</);
    }
  });

  it('is visually distinct from every corner lifecycle glyph', () => {
    // State is one circle family; the members mark remains a distinct route
    // glyph and never joins that lifecycle vocabulary.
    const cornerGlyphs = CORNER_STATUSES.map((status) => cornerStatusPresentation(status).glyph);
    expect(cornerGlyphs).not.toContain(MEMBERS_GLYPH);
    expect(new Set(cornerGlyphs)).toEqual(new Set(['○', '◌', '●']));
  });

  it('names the destination the same way everywhere', () => {
    expect(MEMBERS_LABEL).toBe('Members');
  });
});
