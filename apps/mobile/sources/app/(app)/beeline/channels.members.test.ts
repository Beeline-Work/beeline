import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const legacyAgentsSource = readFileSync(path.join(__dirname, 'agents.tsx'), 'utf8');

describe('Workspace Members entry point', () => {
  it('opens Members from the workspace menu and keeps bookmarks independent', () => {
    expect(source).toContain('<WorkspaceActionsMenu');
    expect(source).toContain("pathname: '/beeline/members'");
    expect(source).toContain('params: { communityId: activeCommunityId }');
    expect(source).toContain("pathname: '/beeline/bookmarks'");
    expect(source).toContain('<RoomListToolbar');
    expect(source).not.toContain('/beeline/agents?communityId=');
  });

  it('redirects legacy agent-management links to Members', () => {
    expect(legacyAgentsSource).toContain(
      "import { Redirect, useLocalSearchParams, type Href } from 'expo-router';",
    );
    expect(legacyAgentsSource).toContain("pathname: '/beeline/members'");
    expect(legacyAgentsSource).toContain('<Redirect href={href} />');
  });
});
