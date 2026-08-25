import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source contracts for the `#` channel-mark convention on the chat surface
 * (captain decision 2026-08, extending PR #484's display-only rule to every
 * surface). What is pinned is authority and immutability, not looks:
 *
 * - the header renders through `channelHeaderTitle` with the mark options —
 *   one naming model (`buzz/room-list-row.ts`), never an ad-hoc prefix;
 * - the mark NEVER reaches a mutation path: rename drafts seed from the
 *   STORED name, and cache writes keep raw names;
 * - the pinned corner line composes `#<room>/<corner>` through
 *   `displayCornerTitle`, the same derivation every other surface uses.
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');
const sessionSource = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'buzz', 'corner-session.ts'),
  'utf8',
);
const rowSource = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'buzz', 'room-list-row.ts'),
  'utf8',
);

describe('the # channel-mark convention on the chat surface', () => {
  it('renders the header through the shared derivation, not a local prefix', () => {
    expect(chatSource).toContain('channelHeaderTitle(');
    expect(chatSource).toContain('directMessage: isDirectMessage');
    expect(chatSource).toContain('parentRoomName');
    // The screen never concatenates a bare `#` onto a name itself.
    expect(chatSource).not.toMatch(/`\$\{headerTitle\}|' #' \+/);
    // The convention lives in exactly one module.
    expect(sessionSource).toContain("from '@/buzz/room-list-row'");
  });

  it('never lets the mark reach a mutation path', () => {
    // Rename seeds the STORED name; the marked header title must not be
    // written back as if it were the room's real name.
    expect(chatSource).toContain('setRenameDraft(storedRoomName)');
    expect(chatSource).toContain(
      'const storedRoomName = resolvedChannelName?.trim() || ROOM_LABEL',
    );
    // Cache and relay writes keep raw names (existing raw-name paths intact).
    expect(chatSource).toContain('patchChannelCache(identity.publicKey, { roomName: name })');
    expect(chatSource).not.toContain("roomName: `#${'");
  });

  it('composes the pinned corner line through displayCornerTitle', () => {
    expect(chatSource).toContain("import { displayCornerTitle } from '@/buzz/room-list-row'");
    expect(chatSource).toContain(
      'displayCornerTitle(\n      resolvedChannelName?.trim() || undefined,',
    );
    // One naming model for both forms.
    expect(rowSource).toContain('export function displayCornerTitle(');
    expect(rowSource).toContain('export function displayRoomIndexTitle(');
  });
});
