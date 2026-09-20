import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { typeRoles, space } from '@/buzz/groknight';

/**
 * Design invariants for the chat screen's top bar — the Room and its Corners
 * must speak ONE header language: identity mark leading, title at its own
 * tier, and every piece of metadata in one shared `meta`-role voice (C72).
 * Source assertions in the same style as `channels.design.test.ts`, because
 * what they lock in is structural: which shared primitive renders a thing.
 * DESIGN.md (repo root) is the authority they encode.
 */
const chatSource = readFileSync(
  path.join(__dirname, '../../app/(app)/beeline/chat/_chat-surface.tsx'),
  'utf8',
);
const ladderSource = readFileSync(path.join(__dirname, './HeaderLadder.tsx'), 'utf8');
const workPaneHandleSource = readFileSync(
  path.join(__dirname, '../DesktopWorkPaneHandle.tsx'),
  'utf8',
);
const repositorySubtitleSource = readFileSync(
  path.join(__dirname, './RoomRepositorySubtitle.tsx'),
  'utf8',
);

describe('Chat header — one language for Room and Corner', () => {
  it('routes both surfaces’ header metadata through the shared micro-caps token', () => {
    // The repo binding and the corner status both read
    // through HeaderMetaCaps — no hand-rolled meta text per branch.
    const uses = chatSource.match(/<HeaderMetaCaps/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    // The superseded per-branch styles are gone; a reintroduction would be a
    // second vocabulary growing beside the shared one.
    for (const retired of [
      'headerMeta:',
      'repoChipText:',
      'cornerHeaderMeta:',
      'cornerHeaderStatusRow:',
      'cornerHeaderMark:',
    ]) {
      expect(chatSource, `${retired} should stay retired`).not.toContain(retired);
    }
  });

  it('renders no workspace mark in the Room top bar', () => {
    // Owner trim (2026-08-23): the workspace glyph was removed from the room
    // header entirely — it stays only on the workspace list's own surfaces.
    expect(chatSource).not.toContain('room-header-workspace-mark');
    expect(chatSource).not.toMatch(/<IdentityMark\s*\n\s*kind="workspace"/);
  });

  it('keeps membership out of the header and on both overflow sheets', () => {
    // Owner trim (2026-08-23): "3 participants · IN THIS ROOM" became
    // "3 members" (singular "1 member") on every surface.
    expect(chatSource).not.toContain('IN THIS ROOM  ›');
    expect(chatSource).not.toContain("}' participants");
    expect(chatSource).not.toContain('testID="corner-header-meta"');
    const directMessageMeta = chatSource.match(
      /<HeaderMetaCaps testID="room-header-meta">[\s\S]*?<\/HeaderMetaCaps>/,
    );
    expect(directMessageMeta, 'missing Direct Message metadata').toBeTruthy();
    expect(directMessageMeta![0]).not.toContain('formatRoomParticipantTotal');
    // Room overflow and corner overflow each carry one Members row. The
    // header diamond opens corners, not the roster (#1432 masking).
    expect(chatSource.match(/testID="room-participant-roster-trigger"/g)).toHaveLength(2);
    expect(chatSource.match(/label="Members"/g)).toHaveLength(2);
    expect(
      chatSource.match(/formatRoomParticipantTotal\(roomParticipantTotal\)/g).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps the repository subtitle in the shared meta token', () => {
    const subtitle = repositorySubtitleSource.match(/subtitle:\s*\{[^}]*\}/);
    expect(subtitle, 'missing repository subtitle alignment style').toBeTruthy();
    expect(subtitle![0]).toContain("alignSelf: 'flex-start'");
    expect(repositorySubtitleSource).toContain('<HeaderMetaCaps');

    const caps = ladderSource.match(/metaCaps:\s*\{[\s\S]*?\n\s*\},/);
    expect(caps, 'missing shared metadata font token').toBeTruthy();
    expect(caps![0]).toMatch(/\.\.\.theme\.buzz\.type\.meta/);
  });

  it('keeps membership out of the trailing header slot', () => {
    expect(chatSource).not.toContain('styles.roomMembersButton');
    expect(chatSource).not.toContain('roomMembersButton:');
  });

  it('leads the Corner with the agent mark through the same slot', () => {
    // The mark names the corner's OWN agent: the pure helper's owner pubkey
    // (server projection, transcript-derived only as cold-start fallback),
    // never whoever currently holds a live turn.
    const branch = chatSource.indexOf('{isCorner && cornerOwnerPubkey && (');
    expect(branch, 'missing the Corner mark branch').toBeGreaterThanOrEqual(0);
    const window = chatSource.slice(branch, branch + 400);
    expect(window).toContain('<HeaderIdentitySlot testID="corner-header-agent">');
    expect(window).toContain('<IdentityMark');
  });

  it('hangs the title on the Room list’s own name axis (C83)', () => {
    // 12 (header padding) + 44 (back target) + 12 = 68, the same left edge a
    // Room-list row's name sits on (16 + 40 tile slot + 12, `channels.tsx`).
    // Pushing a row open must not shift the name sideways.
    const header = chatSource.match(/\n    header:\s*\{[\s\S]*?\n    \},/);
    expect(header, 'missing header style').toBeTruthy();
    expect(header![0]).toContain('paddingHorizontal: 12');
    const back = chatSource.match(/backButton:\s*\{[\s\S]*?\n    \},/);
    expect(back, 'missing backButton style').toBeTruthy();
    expect(back![0]).toContain('width: 44');
    expect(back![0]).toContain('marginRight: 12');
  });

  it('parts trailing actions from the title column and keeps edge targets over 48', () => {
    const actions = chatSource.match(/roomActionsButton:\s*\{[\s\S]*?\n    \},/);
    expect(actions, 'missing roomActionsButton style').toBeTruthy();
    expect(actions![0]).toContain('minWidth: 44');
    expect(actions![0]).toContain('marginLeft: 12');
    // The archived badge takes the same trailing axis.
    const badge = chatSource.match(/archivedBadge:\s*\{[\s\S]*?\n    \},/);
    expect(badge![0]).toContain('marginLeft: 12');
    // 44 of chrome + 4 all round clears Android's 48dp floor without moving a
    // pixel, so both edge glyphs stay optically centred on their own margins.
    expect(chatSource).toContain(
      'const HEADER_EDGE_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;',
    );
    // Back, lone corner overflow, and the named corners door all carry 44 of
    // chrome themselves, so they take the small edge slop.
    expect(chatSource.match(/hitSlop=\{HEADER_EDGE_HIT_SLOP\}/g)).toHaveLength(3);
  });

  it('names the Room corners door and parts it from overflow', () => {
    // A lone brass `◇` a few pixels from the overflow dots read as decoration
    // on the menu. The door is NAMED instead, the way every rail command is:
    // the sigil states the kind, the word states the destination, and one
    // full space step parts the pair from the dots.
    expect(chatSource).toContain('testID="room-corners-menu"');
    expect(chatSource).toContain('accessibilityLabel={`${ROOM_LABEL} ${CHANGES_LABEL}`}');
    expect(chatSource).toContain('<Text style={styles.roomCornersGlyph}>◇</Text>');
    expect(chatSource).toContain('<Text style={styles.roomCornersLabel}>{CHANGES_LABEL}</Text>');
    expect(chatSource).toContain('router.push(roomCornersHref(decodedId))');
    expect(chatSource).toContain("from '@/buzz/corner-navigation'");
    expect(chatSource).toContain('roomCornersHref');
    // DMs and the corner's own header do not grow this control.
    const glyph = chatSource.slice(
      chatSource.indexOf('{!parentChannelId && !isDirectMessage && ('),
      chatSource.indexOf('testID="room-corners-menu"'),
    );
    expect(glyph).toContain('!parentChannelId && !isDirectMessage');
    // Brass stays on the sigil alone — the corner lifecycle family's own mark.
    // The word takes the calm metadata voice the rest of the header speaks in,
    // so the pair is never two accents shouting at each other.
    const diamond = chatSource.match(/roomCornersGlyph:\s*\{[\s\S]*?\n    \},/);
    expect(diamond, 'missing roomCornersGlyph style').toBeTruthy();
    expect(diamond![0]).toContain('color: groknight.accent');
    expect(diamond![0]).toContain('...groknight.type.hero');
    expect(diamond![0]).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // Captain 2026-09-20: the sigil must not read as a speck beside the menu.
    // Its type box is measured against the overflow dots' own, not eyeballed.
    const dotsSize = Number(
      chatSource.match(/roomActionsGlyph:\s*\{[\s\S]*?fontSize:\s*(\d+)/)![1],
    );
    expect(typeRoles.hero.fontSize).toBeGreaterThan(dotsSize);
    expect(typeRoles.hero.lineHeight).toBeGreaterThanOrEqual(dotsSize);
    const word = chatSource.match(/roomCornersLabel:\s*\{[\s\S]*?\n    \},/);
    expect(word, 'missing roomCornersLabel style').toBeTruthy();
    expect(word![0]).toContain('...groknight.type.meta');
    expect(word![0]).toContain('color: groknight.textMuted');
    expect(word![0]).not.toMatch(/fontSize:|letterSpacing:|textTransform:/);
    const dots = chatSource.match(/roomActionsGlyph:\s*\{[\s\S]*?\n    \},/);
    expect(dots![0]).toContain('color: groknight.steel');
    expect(dots![0]).toContain('fontSize: 12');
    // Its own 44pt-tall target, so it is a destination rather than chrome
    // hanging off the menu.
    const doorButton = chatSource.match(/roomCornersButton:\s*\{[\s\S]*?\n    \},/);
    expect(doorButton![0]).toContain('minHeight: 44');
    expect(doorButton![0]).toContain('marginLeft: 12');
    expect(doorButton![0]).toContain("flexDirection: 'row'");
    expect(doorButton![0]).toContain('gap: groknight.space.xs');
    // Bare slab between the named door and the dots, on top of the door's own
    // padding: two controls a thumb must hit separately cannot share an edge.
    const clustered = chatSource.match(/roomClusteredActionsButton:\s*\{[\s\S]*?\n    \},/);
    expect(clustered, 'missing trailing overflow style').toBeTruthy();
    expect(clustered![0]).toContain('marginLeft: groknight.space.lg');
    expect(space.lg).toBeGreaterThan(space.md);
    expect(chatSource).toContain(
      'const HEADER_TRAILING_HIT_SLOP = { top: 14, bottom: 14, left: 14, right: 14 } as const;',
    );
    expect(chatSource.match(/hitSlop=\{HEADER_TRAILING_HIT_SLOP\}/g)).toHaveLength(1);
    // No badge, plate or count grows on it: a door says where it goes, and
    // the list behind it does the counting.
    expect(chatSource).not.toMatch(/roomCorners(?:Badge|Count|Plate)/);
    expect(chatSource).not.toContain('backgroundColor: groknight.brassWash');
  });

  it('leaves one quiet, overlaid tab when the desktop work pane is dismissed', () => {
    const handle = workPaneHandleSource.match(/\n  handle:\s*\{[\s\S]*?\n  \},/);
    expect(handle, 'missing work pane handle style').toBeTruthy();
    expect(handle![0]).toContain('width: 14');
    expect(handle![0]).toContain('height: 40');
    expect(handle![0]).toContain('backgroundColor: theme.buzz.bgRaised');
    expect(handle![0]).toContain('borderTopLeftRadius: theme.buzz.radius');
    expect(handle![0]).toContain('borderBottomLeftRadius: theme.buzz.radius');
    expect(handle![0]).not.toMatch(/alignSelf:\s*'stretch'|borderRight/);
    expect(workPaneHandleSource).toContain("backgroundColor: theme.buzz.bgHighlight");
    expect(workPaneHandleSource).toContain("color: theme.buzz.accent");
    expect(workPaneHandleSource).toContain('width: 0');
  });

  it('lets the corner’s agent name give before the facts beside it do', () => {
    // An unshrinkable name pushed the presence light, the status glyph and
    // the member count off the right edge of the corner's meta row.
    const agent = chatSource.match(/cornerHeaderAgent:\s*\{[\s\S]*?\n    \},/);
    expect(agent, 'missing cornerHeaderAgent style').toBeTruthy();
    expect(agent![0]).toContain('flexShrink: 1');
    expect(agent![0]).toContain('minWidth: 0');
    expect(agent![0]).not.toContain('flexShrink: 0');
  });

  it('keeps the shared ladder tokens in the calm meta role on the canvas', () => {
    // The one metadata voice: the `meta` type role (sans 13, never mono),
    // muted; no raw size or tracking of its own (C72).
    const caps = ladderSource.match(/metaCaps:\s*\{[\s\S]*?\n\s*\},/);
    expect(caps, 'missing metaCaps style').toBeTruthy();
    expect(caps![0]).toMatch(/\.\.\.theme\.buzz\.type\.meta/);
    expect(caps![0]).not.toMatch(/Typography\.mono\(|fontSize:|letterSpacing:/);
    expect(caps![0]).toMatch(/color:\s*groknight\.textMuted/);
    // The slot carries no box of its own: chrome sits on the slab.
    const slot = ladderSource.match(/identitySlot:\s*\{[^}]*\}/);
    expect(slot, 'missing identitySlot style').toBeTruthy();
    expect(slot![0]).not.toMatch(/borderWidth|borderRadius|backgroundColor/);
  });

  it('closes the corner’s ladder rung to match the Room’s (C85)', () => {
    // The shared HeaderMetaRow is now the corner's alone (the Room's members
    // line went back to a bare HeaderMetaCaps); its rung above the meta row
    // matches the Room's own rung (repoChip's marginTop: 2), not the wider
    // gap it carried before.
    const metaRow = ladderSource.match(/metaRow:\s*\{[\s\S]*?\n\s*\},/);
    expect(metaRow, 'missing metaRow style').toBeTruthy();
    expect(metaRow![0]).toContain('marginTop: 2');
  });

  it('carries no presence light or state glyph, but states canonical progress in words', () => {
    // Captain correction: inside a corner the working state is already
    // carried by the thinking line above the composer and the live bar, and
    // the Room list carries corner state for when you're outside it — a
    // silent glyph in the header is a third copy of the same fact. Only the
    // presence square (#873's already-retired signal: a helper can be up
    // while the agent answers nothing) and the CornerGlyph state circle are
    // gone; CornerGlyph/StateCircle themselves still serve the Room list,
    // corner cards, and the live bar.
    expect(chatSource).not.toContain('corner-header-presence');
    expect(chatSource).not.toContain('AgentPresenceLight');
    expect(chatSource).not.toContain('cornerAgentOnline');
    expect(chatSource).not.toContain('corner-view-status');
    expect(chatSource).not.toContain('displayedCornerStatus');
    // The header's identity and state word come from the one pure helper:
    // owner pubkey, `reviewing` while a non-owner holds the live turn, and
    // the owner-only gold ring all derive from `cornerHeaderAgent`.
    expect(chatSource).toContain('cornerHeaderAgent(');
    expect(chatSource).toContain('cornerHeaderAgentView.stateWord');
    expect(chatSource).toContain('cornerHeaderAgentView.ownerWorking');
    expect(chatSource).not.toContain('cornerHeaderStateLabel');
    // Membership is in overflow; the subtitle carries opener + canonical state.
    const branch = chatSource.match(/isCorner \? \(\s*<HeaderMetaRow>[\s\S]*?<\/HeaderMetaRow>/);
    expect(branch, 'missing corner meta row branch').toBeTruthy();
    expect(branch![0]).toContain('cornerHeaderAgent');
    expect(branch![0]).toContain('{cornerHeaderWord}');
    expect(branch![0]).not.toContain('formatRoomParticipantTotal(roomParticipantTotal)');
  });
});
