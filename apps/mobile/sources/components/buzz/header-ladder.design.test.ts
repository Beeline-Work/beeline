import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design invariants for the chat screen's top bar — the Room and its Corners
 * must speak ONE header language: identity mark leading, title at its own
 * tier, and every piece of metadata in one shared mono micro-caps voice.
 * Source assertions in the same style as `channels.design.test.ts`, because
 * what they lock in is structural: which shared primitive renders a thing.
 * DESIGN.md (repo root) is the authority they encode.
 */
const chatSource = readFileSync(
  path.join(__dirname, '../../app/(app)/buzz/chat/[channelId].tsx'),
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
    const meta = chatSource.match(/<HeaderMetaCaps testID="room-header-meta">[\s\S]*?<\/HeaderMetaCaps>/);
    expect(meta, 'missing room-header-meta').toBeTruthy();
    expect(meta![0]).toContain('formatRoomParticipantTotal(roomParticipantTotal)');
  });

  it('leads the Corner with the agent mark through the same slot', () => {
    const branch = chatSource.indexOf('{isCorner && cornerAgentPubkey && (');
    expect(branch, 'missing the Corner mark branch').toBeGreaterThanOrEqual(0);
    const window = chatSource.slice(branch, branch + 400);
    expect(window).toContain('<HeaderIdentitySlot testID="corner-header-agent">');
    expect(window).toContain('<IdentityMark');
  });

  it('keeps the shared ladder tokens mono micro-caps on the canvas', () => {
    // The one metadata voice: IBM Plex Mono at the 10px micro tier, muted.
    const caps = ladderSource.match(/metaCaps:\s*\{[\s\S]*?\n\s*\},/);
    expect(caps, 'missing metaCaps style').toBeTruthy();
    expect(caps![0]).toMatch(/Typography\.mono\(/);
    expect(caps![0]).toMatch(/fontSize:\s*10/);
    expect(caps![0]).toMatch(/color:\s*groknight\.textMuted/);
    // The slot carries no box of its own: chrome sits on the slab.
    const slot = ladderSource.match(/identitySlot:\s*\{[^}]*\}/);
    expect(slot, 'missing identitySlot style').toBeTruthy();
    expect(slot![0]).not.toMatch(/borderWidth|borderRadius|backgroundColor/);
  });
});
