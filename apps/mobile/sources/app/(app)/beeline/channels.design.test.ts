import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const composeSource = readFileSync(
  new URL('../../../components/buzz/RoomDeckComposeMenu.tsx', import.meta.url),
  'utf8',
);
const roomViewSource = readFileSync(
  new URL('../../../../../../packages/api-contract/src/phone-types.ts', import.meta.url),
  'utf8',
);
const surfaceGuardSource = readFileSync(
  new URL('../../../../../../packages/api-contract/src/phone-guards.ts', import.meta.url),
  'utf8',
);

function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`    ${name}: {`);
  expect(start, `missing style ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated style ${name}`);
}

describe('Room list layout contract', () => {
  it('keeps the empty deck one quiet block with exactly one brass primary', () => {
    // Captain report C67: two full-width 100pt buttons under centred copy
    // shouted. The empty state sits in the upper third (the FAB anchors the
    // bottom), speaks in calm roles, and offers one 44pt content-width brass
    // button plus a quiet brass text link — never a second box.
    expect(source).toContain('const EMPTY_PRIMARY_HEIGHT = 44');
    expect(styleBlock(source, 'emptyList')).toContain("justifyContent: 'flex-start'");
    expect(styleBlock(source, 'emptyList')).toContain('paddingTop: hull.space.xxl');
    expect(styleBlock(source, 'empty')).toContain("alignItems: 'flex-start'");
    expect(styleBlock(source, 'empty')).not.toMatch(/\bpadding: \d/);
    expect(styleBlock(source, 'emptyTitle')).toContain('...hull.type.body,');
    expect(styleBlock(source, 'emptyTitle')).toContain('color: hull.textPrimary');
    expect(styleBlock(source, 'emptyCopy')).toContain('...hull.type.meta,');
    expect(styleBlock(source, 'emptyCopy')).toContain('color: hull.textMuted');
    expect(styleBlock(source, 'emptyActions')).toContain('gap: hull.space.md');
    expect(styleBlock(source, 'emptyActions')).not.toContain("width: '100%'");
    expect(styleBlock(source, 'emptyPrimary')).toContain('height: EMPTY_PRIMARY_HEIGHT');
    expect(styleBlock(source, 'emptyPrimary')).toContain("alignSelf: 'flex-start'");
    expect(styleBlock(source, 'emptyPrimary')).toContain('backgroundColor: hull.accent');
    expect(styleBlock(source, 'emptyPrimaryLabel')).toContain('...hull.type.bodyStrong,');
    expect(styleBlock(source, 'emptyPrimaryLabel')).toContain('color: hull.textInverted');
    expect(styleBlock(source, 'emptyLink')).not.toMatch(/border|backgroundColor/);
    expect(styleBlock(source, 'emptyLinkLabel')).toContain('...hull.type.meta,');
    expect(styleBlock(source, 'emptyLinkLabel')).toContain('color: hull.accent');
    // No raw sizes and no tracked uppercase anywhere in the empty block.
    for (const name of [
      'empty',
      'emptyTitle',
      'emptyCopy',
      'emptyActions',
      'emptyPrimary',
      'emptyPrimaryLabel',
      'emptyLink',
      'emptyLinkLabel',
    ]) {
      expect(styleBlock(source, name), name).not.toMatch(/fontSize|letterSpacing|textTransform/);
    }
    const emptyDeck = source.slice(
      source.indexOf('ListEmptyComponent='),
      source.indexOf('renderItem='),
    );
    expect(emptyDeck).toContain('>Start a Room</Text>');
    expect(emptyDeck).toContain('>Invite an agent</Text>');
    expect(emptyDeck).toContain('accessibilityRole="link"');
    expect(emptyDeck).not.toContain('<MonoButton');
    expect(emptyDeck).not.toMatch(/[A-Z]{2,} [A-Z]{2,}/);
  });

  it('floats a 44pt brass square compose FAB bottom right, with no header plus', () => {
    // The compose affordance belongs to the deck, not to a footer list cell:
    // rows continue underneath it and no separator divides it from the list.
    expect(source).toContain('pointerEvents="box-none"');
    expect(source).toContain('style={[styles.composeOverlay, { bottom: 16 + insets.bottom }]}');
    expect(source).toContain('<RoomDeckComposeMenu onSelect={compose} />');
    expect(source).not.toContain('styles.footer');
    expect(source).not.toContain('ListFooterComponent');
    expect(styleBlock(source, 'composeOverlay')).toContain("position: 'absolute'");
    expect(styleBlock(source, 'composeOverlay')).toContain('right: 16');
    expect(styleBlock(source, 'composeOverlay')).not.toMatch(/border(?:Top|Bottom|Left|Right)/);
    expect(styleBlock(source, 'list')).toContain('paddingBottom: COMPOSE_FAB_CLEARANCE');
    expect(composeSource).toContain('testID="room-deck-compose-fab"');
    // Speakeasy: a sharp 44pt brass square. Its plus is a geometric SVG in
    // ink, so Android font ascent/descent cannot offset it; no shadow — the
    // hull's own radius token is the only softening, and contrast with the
    // slab is the only affordance.
    expect(composeSource).toContain('const FAB_SIZE = 44');
    expect(styleBlock(composeSource, 'fab')).toContain('width: FAB_SIZE');
    expect(styleBlock(composeSource, 'fab')).toContain('height: FAB_SIZE');
    expect(styleBlock(composeSource, 'fab')).toContain('backgroundColor: groknight.accent');
    expect(styleBlock(composeSource, 'fab')).not.toMatch(/shadow|elevation/);
    expect(styleBlock(composeSource, 'fabGlyph')).toContain('width: FAB_GLYPH_SIZE');
    expect(composeSource).toContain('d="M12 4v16M4 12h16"');
    expect(composeSource).not.toContain('<Text style={styles.fabGlyph}>');
    expect(source).toContain('const COMPOSE_FAB_CLEARANCE = 80');
    // The header carries the Workspace switcher and MEMBERS only: the thin
    // header plus is gone, the FAB is the one way to compose.
    const header = source.slice(
      source.indexOf('<View style={styles.header}>'),
      source.indexOf('<HullDialog'),
    );
    expect(header).not.toMatch(/[+＋]/);
    expect(header).toContain('testID="workspace-members"');
  });

  it('leads with the state column on a 64pt row; only a DM row also wears a 40px tile', () => {
    expect(source).toContain('const ROW_HEIGHT = 64');
    expect(source).toContain('const ROW_TILE_SIZE = 40');
    expect(styleBlock(source, 'row')).toContain('minHeight: ROW_HEIGHT');
    expect(styleBlock(source, 'rowMain')).toContain('minHeight: ROW_HEIGHT');
    // C71: a Room is many voices, so no picture stands for it — the `#name`
    // sigil is its mark. The tile renders only when the one derivation
    // (`roomRowName`) supplies one, i.e. for a DM's peer, and it renders
    // AFTER the leading state column (C81): [state][tile if DM][copy][age].
    const rowStateIndex = source.indexOf('styles.rowStateSlot');
    const tileIndex = source.indexOf('{heading.tile && (');
    const rowCopyIndex = source.indexOf('<View style={styles.rowCopy}>');
    expect(rowStateIndex).toBeGreaterThan(0);
    expect(tileIndex).toBeGreaterThan(rowStateIndex);
    expect(rowCopyIndex).toBeGreaterThan(tileIndex);
    expect(source).toContain('size={ROW_TILE_SIZE}');
    expect(source).toContain('kind={heading.tile.kind}');
    expect(source).toContain('seed={heading.tile.seed}');
    expect(source).not.toContain('rowTileSlot');
    expect(source).not.toContain('room-tile-slot-');
    expect(source).not.toMatch(/kind="workspace"[^\n]*room\.id/);
    expect(styleBlock(source, 'title')).toContain('fontSize: 18');
    expect(styleBlock(source, 'title')).toContain('color: hull.textPrimary');
    expect(styleBlock(source, 'preview')).toContain('color: hull.ledgerQuiet');
    expect(source).toContain('testID={`room-preview-${item.room.id}`}');
    // One size, one weight: unread never bolds, enlarges, or tints the row.
    expect(source).not.toContain('titleUnread');
    expect(source).not.toContain('rowUnread');
    expect(source).not.toContain('bgUnread');
  });

  it('draws the sigil — the name’s first glyph — in brass ahead of the name', () => {
    // `@` for a DM, `#` for a Room; both come from one derivation.
    expect(source).toContain("from '@/buzz/room-list-row'");
    expect(source).toContain('const heading = roomRowName(item);');
    expect(source).toContain('testID={`room-sigil-${item.room.id}`}');
    expect(source).toContain('{heading.sigil}');
    expect(styleBlock(source, 'sigil')).toContain('color: hull.accent');
    expect(source).not.toContain('displayRoomIndexTitle(item.room.name)');
  });

  it('attributes the preview: `you:` muted, `@handle:` brass, empty Room plain', () => {
    expect(source).toContain('const preview = roomRowPreview(item, chatList.viewer.pubkey);');
    expect(source).toContain("preview.attribution === 'self' && (");
    expect(source).toContain('<Text style={styles.previewSelf}>you: </Text>');
    expect(source).toContain("preview.attribution === 'other' && (");
    expect(source).toContain('<Text style={styles.previewAuthor}>@{preview.handle}: </Text>');
    expect(styleBlock(source, 'previewSelf')).toContain('color: hull.textMuted');
    expect(styleBlock(source, 'previewAuthor')).toContain('color: hull.accent');
    expect(source).not.toContain('No activity yet');
  });

  it('leads every row with one 7×7 brass state mark and nothing else; the gutter keeps only the timestamp', () => {
    // `unread` is server-owned and cross-device; a corner waiting on a human
    // lights the same mark. The leading slot exists on every row — DM and
    // Room alike — so whatever follows it (a DM's tile, a Room's copy) never
    // shifts between lit and unlit rows; and there is no count, no NEW label,
    // no gold dot. An unlit row draws nothing at all: the mark element itself
    // only renders when `attention` is true.
    expect(roomViewSource).toContain('readonly unread: boolean;');
    expect(surfaceGuardSource).toContain("typeof item.unread === 'boolean'");
    expect(surfaceGuardSource).not.toContain('item.unread === undefined');
    expect(source).toContain('const attention = roomRowNeedsAttention(item);');
    expect(source).toContain('const ATTENTION_SQUARE = 7');
    expect(source).toContain('<View style={styles.rowStateSlot} accessibilityElementsHidden>');
    expect(source).toContain('{attention && (');
    expect(source).toContain('style={styles.rowStateMark}');
    expect(source).toContain('testID={`room-attention-${item.room.id}`}');
    expect(styleBlock(source, 'rowStateSlot')).toContain('width: ATTENTION_SQUARE');
    expect(styleBlock(source, 'rowStateSlot')).toContain('height: ATTENTION_SQUARE');
    expect(styleBlock(source, 'rowStateMark')).toContain('width: ATTENTION_SQUARE');
    expect(styleBlock(source, 'rowStateMark')).toContain('height: ATTENTION_SQUARE');
    expect(styleBlock(source, 'rowStateMark')).toContain('backgroundColor: hull.accent');
    expect(source).not.toContain('attentionSquare');
    expect(source).not.toContain('NEW');
    expect(source).not.toContain('HullDeckMark');
    expect(source).not.toContain('roomDeckState');
    expect(source).not.toContain("unread ? 'needs-you' : 'idle'");
    // The gutter carries only the timestamp — no mark, lit or unlit — so its
    // position never depends on row state.
    const gutterBlock = source.slice(
      source.indexOf('<View style={styles.gutter}>'),
      source.indexOf('<View style={styles.cornerToggleSlot}>'),
    );
    expect(gutterBlock).toContain('<Text style={styles.age}>{age}</Text>');
    expect(gutterBlock).not.toContain('rowStateSlot');
    expect(gutterBlock).not.toContain('rowStateMark');
    expect(source).toContain("import { compactRelativeTime } from '@/buzz/relative-time';");
  });

  it('gives every Room with live corners an inline expansion and navigation affordance', () => {
    expect(source).toContain("import { formatRoomCornerCount } from '@/buzz/vocabulary';");
    expect(source).toContain('const cornerCount = formatRoomCornerCount(item.cornerCount);');
    expect(source).toContain('item.cornerCount > 0 && (');
    expect(source).toContain('accessibilityState={{ expanded }}');
    expect(source).toContain('testID={`room-corners-toggle-${item.room.id}`}');
    expect(source).toContain('testID={`room-corners-${item.room.id}`}');
    expect(source).toContain('testID={`room-corner-${corner.corner.id}`}');
    expect(source).toContain("'room-list',");
    expect(source).toContain('<Text style={styles.cornerStatus}>{status}</Text>');
    // The toggle slot is reserved on every row so the age column keeps one
    // straight right edge whether or not a Room has corners.
    expect(styleBlock(source, 'cornerToggleSlot')).toContain('width: 32');
  });
});
