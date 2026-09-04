import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * C72 — the chat header is on-brand with the Room list: ONE shared title
 * renderer (`ChannelHeaderTitle`) for Room, DM and corner draws the kind
 * sigil in brass and the name in the calm type roles. The screen never sets a
 * header title face, size or mono style of its own again, and every subtitle
 * under it reads through the `meta` role.
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');
const componentsDir = path.join(__dirname, '..', '..', '..', '..', 'components', 'buzz');
const titleSource = readFileSync(path.join(componentsDir, 'ChannelHeaderTitle.tsx'), 'utf8');
const ladderSource = readFileSync(path.join(componentsDir, 'HeaderLadder.tsx'), 'utf8');

describe('the chat header title (C72)', () => {
  it('renders every header title through the one shared renderer', () => {
    expect(chatSource).toContain("import { ChannelHeaderTitle } from '@/components/buzz/ChannelHeaderTitle'");
    expect(chatSource.match(/<ChannelHeaderTitle\b/g)).toHaveLength(2);
    expect(chatSource).toContain(
      "const headerTitleKind: ChannelHeaderKind = isCorner ? 'corner' : dmPeerPubkey ? 'dm' : 'room';",
    );
    // The screen owns no header title style any more.
    expect(chatSource).not.toMatch(/channelName:|cornerChannelName:/);
  });

  it('draws the sigil in brass and the name in the calm roles, never mono', () => {
    expect(titleSource).toContain("from '@/buzz/channel-header-title'");
    expect(titleSource).toContain('sigil: { color: theme.buzz.accent }');
    expect(titleSource).toContain('...theme.buzz.type.hero');
    expect(titleSource).toContain('...theme.buzz.type.bodyStrong');
    expect(titleSource).not.toMatch(/fontSize:|letterSpacing:|Typography\.|theme\.buzz\.type\.machine|Mono/);
  });

  it('sets every header subtitle in the meta role', () => {
    expect(ladderSource).toContain('...theme.buzz.type.meta');
    expect(ladderSource).not.toMatch(/Typography\.mono|fontSize:|letterSpacing:/);
  });
});
