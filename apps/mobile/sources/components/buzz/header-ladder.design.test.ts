import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design invariants for the chat screen's top bar — the Room and its Corners
 * must speak ONE header language: identity mark leading, title at its own
 * tier, and every piece of metadata in one shared `meta`-role voice (C72).
 * Source assertions in the same style as `channels.design.test.ts`, because
 * what they lock in is structural: which shared primitive renders a thing.
 * DESIGN.md (repo root) is the authority they encode.
 */
const chatSource = readFileSync(
  path.join(__dirname, '../../app/(app)/beeline/chat/[channelId].tsx'),
  'utf8',
);
const ladderSource = readFileSync(path.join(__dirname, './HeaderLadder.tsx'), 'utf8');

describe('Chat header — one language for Room and Corner', () => {
  it('routes both surfaces’ header metadata through the shared micro-caps token', () => {
    // The repo binding, the member count line, and the corner status all read
    // through HeaderMetaCaps — no hand-rolled meta text per branch.
    const uses = chatSource.match(/<HeaderMetaCaps/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
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

  it('phrases the Room count as "N members", with no location suffix', () => {
    // Owner trim (2026-08-23): "3 participants · IN THIS ROOM" became
    // "3 members" (singular "1 member") on every surface.
    expect(chatSource).not.toContain('IN THIS ROOM  ›');
    expect(chatSource).not.toContain("}' participants");
    const meta = chatSource.match(
      /<HeaderMetaCaps testID="room-header-meta">[\s\S]*?<\/HeaderMetaCaps>/,
    );
    expect(meta, 'missing room-header-meta').toBeTruthy();
    expect(meta![0]).toContain('formatRoomParticipantTotal(roomParticipantTotal)');
  });

  it('keeps the repo and member lines on one left axis in the shared meta token', () => {
    const repoChip = chatSource.match(/repoChip:\s*\{[^}]*\}/);
    expect(repoChip, 'missing repo chip alignment style').toBeTruthy();
    expect(repoChip![0]).toContain("alignSelf: 'flex-start'");

    const memberMeta = chatSource.match(
      /<HeaderMetaCaps testID="room-header-meta">[\s\S]*?<\/HeaderMetaCaps>/,
    );
    expect(memberMeta, 'missing room member metadata').toBeTruthy();
    expect(memberMeta![0]).toContain('`${formatRoomParticipantTotal(roomParticipantTotal)}  ›`');
    expect(memberMeta![0]).not.toContain('`  ${formatRoomParticipantTotal(roomParticipantTotal)}');

    const caps = ladderSource.match(/metaCaps:\s*\{[\s\S]*?\n\s*\},/);
    expect(caps, 'missing shared metadata font token').toBeTruthy();
    expect(caps![0]).toMatch(/\.\.\.theme\.buzz\.type\.meta/);
  });

  it('keeps the Room’s members line bare, not parted into its own meta-row rung (C85)', () => {
    // #884 wrapped the Room's members line in a HeaderMetaRow to part it from
    // the repo chip by a rung of the ladder; the captain wanted the old,
    // tighter spacing back. The corner's own HeaderMetaRow (its status row)
    // is unrelated and stays.
    const roomBranch = chatSource.match(
      /\) : \(\n\s*<HeaderMetaCaps testID="room-header-meta">[\s\S]*?<\/HeaderMetaCaps>\n\s*\)\}/,
    );
    expect(roomBranch, 'Room members line should render bare, unwrapped').toBeTruthy();
    expect(chatSource).not.toContain('paddingVertical: 4');
  });

  it('leads the Corner with the agent mark through the same slot', () => {
    const branch = chatSource.indexOf('{isCorner && cornerAgentPubkey && (');
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

  it('parts the trailing control from the title column and keeps both edge targets over 48', () => {
    // Material asks for 8dp between adjacent targets; the title column is a
    // touchable of its own, so the overflow cannot sit flush against it.
    const actions = chatSource.match(/roomActionsButton:\s*\{[\s\S]*?\n    \},/);
    expect(actions, 'missing roomActionsButton style').toBeTruthy();
    expect(actions![0]).toContain('marginLeft: 12');
    expect(actions![0]).toContain('minWidth: 44');
    // The archived badge takes the same trailing axis.
    const badge = chatSource.match(/archivedBadge:\s*\{[\s\S]*?\n    \},/);
    expect(badge![0]).toContain('marginLeft: 12');
    // 44 of chrome + 4 all round clears Android's 48dp floor without moving a
    // pixel, so both edge glyphs stay optically centred on their own margins.
    expect(chatSource).toContain(
      'const HEADER_EDGE_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;',
    );
    expect(chatSource.match(/hitSlop=\{HEADER_EDGE_HIT_SLOP\}/g)).toHaveLength(3);
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

  it('carries neither the presence light nor the state glyph in the corner header (C85)', () => {
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
    expect(chatSource).not.toContain('cornerHeaderState');
    // The meta row still reads: agent name, then member count.
    const branch = chatSource.match(/isCorner \? \(\s*<HeaderMetaRow>[\s\S]*?<\/HeaderMetaRow>/);
    expect(branch, 'missing corner meta row branch').toBeTruthy();
    expect(branch![0]).toContain('cornerHeaderAgent');
    expect(branch![0]).toContain('formatRoomParticipantTotal(roomParticipantTotal)');
  });
});
