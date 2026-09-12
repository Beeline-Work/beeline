import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const composeSource = readFileSync(
  new URL('../../../components/buzz/RoomDeckComposeMenu.tsx', import.meta.url),
  'utf8',
);
const sectionHeaderSource = readFileSync(
  new URL('../../../components/buzz/RoomListSectionHeader.tsx', import.meta.url),
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
const desktopInspectorSource = readFileSync(
  new URL('../../../components/DesktopRoomInspector.tsx', import.meta.url),
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
  it('places DMs beneath Rooms under a conditional Messages heading', () => {
    expect(source).toContain('<SectionList');
    expect(source).toContain('sections={chatSections}');
    expect(source).toContain('roomListSections(chatList?.chats ?? [])');
    expect(source).toContain('section.title ? <RoomListSectionHeader title={section.title} /> : null');
    expect(sectionHeaderSource).toContain('{title.toUpperCase()}');
    expect(sectionHeaderSource).toContain('accessibilityRole="header"');
    expect(styleBlock(sectionHeaderSource, 'sectionHeaderText')).toContain('...hull.type.sectionHead,');
    expect(source).not.toContain('<FlatList');
  });

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
  });

  it('aligns Room and Direct Message copy after the state column on a 64pt row', () => {
    expect(source).toContain('const ROW_HEIGHT = 64');
    expect(styleBlock(source, 'row')).toContain('minHeight: ROW_HEIGHT');
    expect(styleBlock(source, 'rowMain')).toContain('minHeight: ROW_HEIGHT');
    // Both kinds use their brass sigil as the mark, so opening a DM never
    // shifts its copy onto a different axis: [state][copy][age].
    const rowStateIndex = source.indexOf('styles.rowStateSlot');
    const rowCopyIndex = source.indexOf('<View style={styles.rowCopy}>');
    expect(rowStateIndex).toBeGreaterThan(0);
    expect(rowCopyIndex).toBeGreaterThan(rowStateIndex);
    expect(source).not.toContain("from '@/components/buzz/IdentityMark'");
    expect(source).not.toContain('heading.tile');
    expect(source).not.toContain('room-tile-');
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
    expect(source).toContain('{display.word}');
    // The toggle slot is reserved on every row so the age column keeps one
    // straight right edge whether or not a Room has corners.
    expect(styleBlock(source, 'cornerToggleSlot')).toContain('width: 32');
  });

  it('hangs the corner tray off the parent Room’s text edge', () => {
    // The tray's `└` starts on the Room title's left margin, so one vertical
    // line runs from the name down through its corners. That edge is derived
    // from the row's own gutter rather than restated as a literal, so the two
    // cannot drift apart when the row's padding, state column, or gap changes.
    expect(source).toContain('const ROW_PADDING_LEFT = 16');
    expect(source).toContain('const ROW_COPY_GAP = 12');
    expect(source).toContain(
      'const ROW_TEXT_INSET = ROW_PADDING_LEFT + ATTENTION_SQUARE + ROW_COPY_GAP',
    );
    expect(styleBlock(source, 'rowMain')).toContain('paddingLeft: ROW_PADDING_LEFT');
    expect(styleBlock(source, 'rowMain')).toContain('gap: ROW_COPY_GAP');
    expect(styleBlock(source, 'cornerDropdown')).toContain('paddingLeft: ROW_TEXT_INSET');
    expect(source).toContain('const label = displayGroupedCornerTitle(');
    expect(source).toContain('└ {label}');
    expect(source).not.toContain('const label = displayCornerTitle(');
  });

  it('reads one display-state resolver for both the dropdown list and its words', () => {
    // Daemon state, PR, and checks collapse in `corner-display-state.ts` and
    // nowhere else. A screen that re-derives any of the three can disagree with
    // the count on the row above it.
    expect(source).toContain(
      "import { cornerDisplayState, unfinishedCornerDisplay } from '@/buzz/corner-display-state';",
    );
    expect(source).toContain('const display = cornerDisplayState(corner);');
    expect(source).toContain('unfinishedCornerDisplay(corners).map((entry) => entry.item)');
    // The old collapses: a raw lifecycle word as the status, and a filter that
    // read `lifecycle` while the row's count read the daemon.
    expect(source).not.toContain('cornerStatusWord');
    expect(source).not.toContain("lifecycle.lifecycle !== 'done'");
  });

  it('spends brass on a needs-you corner and backs it with copy', () => {
    // Brass on the index means the row is talking to you, and it is never the
    // only signal (DESIGN.md, colour exception 1): the word itself changes to
    // the affordance where every other row reads WORKING or IDLE.
    expect(source).toContain('display.needsYou && styles.cornerStatusNeedsYou');
    expect(source).toContain('display.needsYou && styles.cornerNameNeedsYou');
    expect(styleBlock(source, 'cornerStatusNeedsYou')).toContain('color: hull.accent');
    expect(styleBlock(source, 'cornerNameNeedsYou')).toContain('color: hull.textPrimary');
    // Quiet rows keep the muted tones, so the accent stays rare inside the
    // dropdown rather than becoming its default.
    expect(styleBlock(source, 'cornerStatus')).toContain('color: hull.textMuted');
    expect(styleBlock(source, 'cornerName')).toContain('color: hull.textSecondary');
    // Needs-you is announced, never left to colour.
    expect(source).toContain("display.needsYou ? ', needs you' : ''");
  });

  it('baseline-aligns every corner state word with its chevron on phone and desktop', () => {
    // The mono state word and proportional chevron have different font metrics.
    // Center their shared endcap on the row, then align the glyphs by baseline.
    expect(source).toContain('<View style={styles.cornerEndcap}>');
    expect(styleBlock(source, 'cornerRow')).toContain("alignItems: 'center'");
    expect(styleBlock(source, 'cornerEndcap')).toContain("flexDirection: 'row'");
    expect(styleBlock(source, 'cornerEndcap')).toContain("alignItems: 'baseline'");

    expect(desktopInspectorSource).toContain('<View style={styles.cornerEndcap}>');
    expect(desktopInspectorSource).toContain('{display.word}');
    expect(desktopInspectorSource).toContain("cornerRow: {\n    minHeight: 88,\n    flexDirection: 'row',\n    alignItems: 'center'");
    expect(desktopInspectorSource).toContain(
      "cornerEndcap: { flexDirection: 'row', alignItems: 'baseline'",
    );
  });
});
