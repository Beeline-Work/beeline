import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SidebarView.tsx', import.meta.url), 'utf8');

describe('desktop sidebar workspace synchronization', () => {
  it('follows the workspace persisted by a deep-opened Room', () => {
    expect(source).toContain('subscribeActiveCommunityId');
    expect(source).toContain('if (workspaceIdRef.current === nextWorkspaceId) return;');
    expect(source).toContain('setWorkspaceId(nextWorkspaceId);');
    expect(source).toContain('setSurface(null)');
  });
});

describe('desktop sidebar Room names', () => {
  it('uses the mobile index authorities for names, previews, and attention', () => {
    expect(source).toContain('const rowName = roomRowName(item);');
    expect(source).toContain('const preview = roomRowPreview(item, identityPubkey ?? undefined);');
    expect(source).toContain('const attention = roomRowNeedsAttention(item);');
    expect(source).toContain('{rowName.sigil}');
    expect(source).toContain('{rowName.name}');
    expect(source).not.toContain('HullDeckMark');
    expect(source).not.toContain('unreadDot');
  });
});
