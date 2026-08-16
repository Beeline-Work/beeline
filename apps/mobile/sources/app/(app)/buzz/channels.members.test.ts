import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const legacyAgentsSource = readFileSync(path.join(__dirname, 'agents.tsx'), 'utf8');

describe('Workspace Members entry point', () => {
  it('offers one header entry that opens the unified Members page', () => {
    expect(source.match(/testID="workspace-members"/g)).toHaveLength(1);
    expect(source).toContain('`/buzz/members?communityId=${encodeURIComponent(activeCommunityId)}`');
    expect(source).not.toContain('accessibilityLabel={`${WORKSPACE_LABEL} Agents`}');
    expect(source).not.toContain('/buzz/agents?communityId=');
  });

  it('redirects legacy agent-management links to Members', () => {
    expect(legacyAgentsSource).toContain(
      "import { Redirect, useLocalSearchParams, type Href } from 'expo-router';",
    );
    expect(legacyAgentsSource).toContain("pathname: '/buzz/members'");
    expect(legacyAgentsSource).toContain('<Redirect href={href} />');
  });
});
