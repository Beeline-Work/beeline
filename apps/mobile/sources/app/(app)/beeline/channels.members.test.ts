import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const legacyAgentsSource = readFileSync(path.join(__dirname, 'agents.tsx'), 'utf8');

describe('Workspace Members entry point', () => {
  it('offers one header entry that opens the unified Members page', () => {
    expect(source.match(/testID="workspace-members"/g)).toHaveLength(1);
    expect(source).toContain("pathname: '/beeline/members'");
    expect(source).toContain('params: { communityId: activeCommunityId }');
    expect(source).not.toContain('accessibilityLabel={`${WORKSPACE_LABEL} Agents`}');
    expect(source).not.toContain('/beeline/agents?communityId=');
  });

  it('draws that header entry as MembersGlyph with an accessible name', () => {
    expect(source).toContain('<MembersGlyph');
    expect(source).toContain('testID="workspace-members-glyph"');
    expect(source).toContain(
      'accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}',
    );
    expect(source).not.toContain('MEMBERS_LABEL.toUpperCase()');
    expect(source).not.toContain('headerActionText');
    expect(source).not.toContain('people-outline');
  });

  it('keeps BookmarksGlyph beside MembersGlyph as a matching 16px header tap target', () => {
    expect(source).toContain('<BookmarksGlyph');
    expect(source).toContain('testID="workspace-bookmarks"');
    expect(source).toContain('testID="workspace-bookmarks-glyph"');
    expect(source).toContain("pathname: '/beeline/bookmarks'");
    expect(source).toContain('accessibilityLabel="Bookmarks"');
    const bookmarks = source.slice(
      source.indexOf('testID="workspace-bookmarks"') - 400,
      source.indexOf('testID="workspace-members"'),
    );
    expect(bookmarks).toContain('size={16}');
    expect(bookmarks).toContain('style={styles.headerAction}');
    expect(bookmarks).toContain('hitSlop={HEADER_GLYPH_HIT_SLOP}');
    expect(bookmarks).toContain('style={styles.headerBookmarksGlyph}');
    const members = source.slice(
      source.indexOf('testID="workspace-members"') - 400,
      source.indexOf('testID="workspace-members-glyph"') + 80,
    );
    expect(members).toContain('size={16}');
    expect(members).toContain('style={styles.headerMembersAction}');
    expect(members).toContain('hitSlop={HEADER_GLYPH_HIT_SLOP}');
    expect(members).toContain('<MembersGlyph');
    expect(source.indexOf('workspace-bookmarks')).toBeLessThan(source.indexOf('workspace-members'));
  });

  it('redirects legacy agent-management links to Members', () => {
    expect(legacyAgentsSource).toContain(
      "import { Redirect, useLocalSearchParams, type Href } from 'expo-router';",
    );
    expect(legacyAgentsSource).toContain("pathname: '/beeline/members'");
    expect(legacyAgentsSource).toContain('<Redirect href={href} />');
  });
});
