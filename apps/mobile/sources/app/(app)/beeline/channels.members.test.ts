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

  it('redirects legacy agent-management links to Members', () => {
    expect(legacyAgentsSource).toContain(
      "import { Redirect, useLocalSearchParams, type Href } from 'expo-router';",
    );
    expect(legacyAgentsSource).toContain("pathname: '/beeline/members'");
    expect(legacyAgentsSource).toContain('<Redirect href={href} />');
  });
});
