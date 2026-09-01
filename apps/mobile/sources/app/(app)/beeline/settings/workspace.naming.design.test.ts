import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./workspace.tsx', import.meta.url), 'utf8');
const railSource = readFileSync(
  new URL('../../../../components/buzz/CommunityRail.tsx', import.meta.url),
  'utf8',
);

describe('Workspace naming', () => {
  it('uses Workspace for the page and its rail destination', () => {
    expect(source).toContain('<Text style={styles.title}>{WORKSPACE_LABEL}</Text>');
    expect(source).not.toContain('{WORKSPACE_LABEL} Settings');
    expect(railSource).toContain('label="WORKSPACE"');
    expect(railSource).toContain(
      'accessibilityLabel={`${activeCommunity.name} ${WORKSPACE_LABEL}`}',
    );
    expect(railSource).not.toContain('${WORKSPACE_LABEL} settings');
  });
});
