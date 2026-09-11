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
    expect(chatSource).toContain(
      "import { ChannelHeaderTitle } from '@/components/buzz/ChannelHeaderTitle'",
    );
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
    expect(titleSource).not.toMatch(
      /fontSize:|letterSpacing:|Typography\.|theme\.buzz\.type\.machine|Mono/,
    );
  });

  it('sets every header subtitle in the meta role', () => {
    expect(ladderSource).toContain('...theme.buzz.type.meta');
    expect(ladderSource).not.toMatch(/Typography\.mono|fontSize:|letterSpacing:/);
  });

  it('shows an ordinary Direct Message peer identity without changing Room, system, or corner slots', () => {
    expect(chatSource).toContain(
      '{isDirectMessage && !isReadOnlyDirectMessage && dmPeerPubkey && (',
    );
    expect(chatSource).toContain('<HeaderIdentitySlot testID="direct-message-header-identity">');
    expect(chatSource).toContain(
      "dmPeerAgentDisplay || dmPeerIdentity?.kind === 'agent' ? 'agent' : 'human'",
    );
    expect(chatSource).toContain('seed={dmPeerAgentDisplay?.avatarSeed ?? dmPeerPubkey}');
    expect(chatSource).toContain('name={displayRoomName}');
    expect(chatSource).toContain('<HeaderIdentitySlot testID="corner-header-agent">');
    expect(chatSource).not.toContain('testID="room-header-identity"');
  });

  it('speaks the Direct Message subtitle in sentence case through the shared meta voice', () => {
    // The DM header's one meta line reads through HeaderMetaCaps (the shared
    // `meta`-role voice, C72) and is sentence case — "Direct message", never
    // the tracked-caps "DIRECT MESSAGE" that belongs to section heads only.
    const meta = chatSource.match(
      /<HeaderMetaCaps testID="room-header-meta">[\s\S]*?<\/HeaderMetaCaps>/,
    );
    expect(meta, 'missing room-header-meta subtitle').toBeTruthy();
    expect(meta![0]).toContain("'Direct message'");
    expect(meta![0]).not.toContain("'DIRECT MESSAGE'");
  });
});
