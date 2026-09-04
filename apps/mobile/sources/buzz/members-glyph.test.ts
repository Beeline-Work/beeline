import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MEMBERS_LABEL } from './vocabulary';

/**
 * Every surface that routes a person to the members screen. They share one
 * word and, since captain report C73, no glyph: the angular hexagon that used
 * to sit beside "Members" never belonged to the creature motif. The word
 * alone, in the meta role, is the whole affordance.
 */
const MEMBERS_ENTRY_POINTS = [
  '../app/(app)/beeline/channels.tsx',
  '../app/(app)/beeline/MembersScreen.tsx',
  '../app/(app)/beeline/settings/workspace.tsx',
  '../components/buzz/CommunityInviteEntry.tsx',
  '../components/buzz/RoomRosterSheet.tsx',
];

const RETIRED_GLYPH = '⌬';

describe('the members word', () => {
  it('names the destination the same way everywhere, from the shared vocabulary', () => {
    expect(MEMBERS_LABEL).toBe('Members');
    for (const relativePath of MEMBERS_ENTRY_POINTS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should spread the shared members word`).toContain(
        'MEMBERS_LABEL',
      );
    }
  });

  it('travels alone: no entry point draws a glyph beside it', () => {
    for (const relativePath of MEMBERS_ENTRY_POINTS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} still carries the retired members glyph`).not.toContain(
        RETIRED_GLYPH,
      );
      expect(source, `${relativePath} still imports a members glyph`).not.toContain(
        'MEMBERS_GLYPH',
      );
    }
  });
});
