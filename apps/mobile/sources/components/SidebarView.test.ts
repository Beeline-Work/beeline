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

  it('follows the Workspace encoded by browser history and deep links', () => {
    expect(source).toContain('useGlobalSearchParams');
    expect(source).toContain('workspaceIdRef.current = routeWorkspaceId;');
    expect(source).toContain('saveActiveCommunityId(identityPubkey, routeWorkspaceId)');
  });

  it('renders nested corners with the grouped title formatter', () => {
    expect(source).toContain('displayGroupedCornerTitle(');
    expect(source).not.toContain('{corner.corner.name}\n                                </Text>');
  });

  it('spends brass only on waiting nested corner state', () => {
    expect(source).toContain("corner.state === 'waiting'");
    expect(source).toContain('styles.cornerStateWaiting');
    expect(source).toContain('styles.cornerMetaWaiting');
    expect(source).toContain('cornerStateWaiting: { backgroundColor: theme.buzz.accent }');
    expect(source).toContain('cornerStateQuiet: { backgroundColor: theme.buzz.ledgerQuiet }');
    expect(source).toContain('cornerStateGhost: { backgroundColor: theme.buzz.ledgerGhost }');
    expect(source).toContain('cornerMetaWaiting: { color: theme.buzz.accent }');
    expect(source).toContain('cornerMetaQuiet: { color: theme.buzz.ledgerQuiet }');
    expect(source).toContain('cornerMetaGhost: { color: theme.buzz.ledgerGhost }');
  });

  it('keeps DM presence out of list rows', () => {
    expect(source).not.toContain('directMessagePresence');
    expect(source).not.toContain('presenceCaption');
    expect(source).not.toContain('presenceDot');
    expect(source).not.toContain('desktop-room-presence-');
  });
});
