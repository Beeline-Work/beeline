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
const cornerHeaderSource = readFileSync(new URL('./chat/_chat-surface.tsx', import.meta.url), 'utf8');
const cornerListSource = readFileSync(new URL('./corners/[roomId].tsx', import.meta.url), 'utf8');
const roomCornersListSource = readFileSync(
  new URL('../../../components/buzz/RoomCornersList.tsx', import.meta.url),
  'utf8',
);
const cornerTitleTypeface = readFileSync(
  new URL('../../../assets/fonts/SpaceGrotesk-SemiBold.ttf', import.meta.url),
);
const cornerLabelTypeface = readFileSync(
  new URL('../../../assets/fonts/SpaceGrotesk-Medium.ttf', import.meta.url),
);

function styleBlock(text: string, name: string, indent = '    '): string {
  const start = text.indexOf(`${indent}${name}: {`);
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

function tableOffset(font: Buffer, wantedTag: string): number {
  const tableCount = font.readUInt16BE(4);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (font.toString('ascii', record, record + 4) === wantedTag) {
      return font.readUInt32BE(record + 8);
    }
  }
  throw new Error(`missing ${wantedTag} font table`);
}

/** Distance from a capital glyph's center to its centered typographic line box. */
function capCenterOffset(font: Buffer, fontSize: number): number {
  const head = tableOffset(font, 'head');
  const os2 = tableOffset(font, 'OS/2');
  const unitsPerEm = font.readUInt16BE(head + 18);
  const ascender = font.readInt16BE(os2 + 68);
  const descender = font.readInt16BE(os2 + 70);
  const capHeight = font.readInt16BE(os2 + 88);
  return ((ascender + descender - capHeight) / 2 / unitsPerEm) * fontSize;
}

describe('Room list layout contract', () => {
  it('places DMs beneath Rooms under a conditional Messages heading', () => {
    expect(source).toContain('<SectionList');
    expect(source).toContain('sections={chatSections}');
    expect(source).toContain('roomListSections(chatList?.chats ?? [])');
    expect(source).toContain(
      'section.title ? <RoomListSectionHeader title={section.title} /> : null',
    );
    expect(sectionHeaderSource).toContain('{title.toUpperCase()}');
    expect(sectionHeaderSource).toContain('accessibilityRole="header"');
    expect(styleBlock(sectionHeaderSource, 'sectionHeaderText')).toContain(
      '...hull.type.sectionHead,',
    );
    expect(source).not.toContain('<FlatList');
  });

  it('renders the empty deck as one aligned pair of quiet framed buttons', () => {
    expect(styleBlock(source, 'emptyList')).toContain("justifyContent: 'flex-start'");
    expect(styleBlock(source, 'emptyList')).toContain('paddingTop: hull.space.xxl');
    expect(styleBlock(source, 'empty')).toContain("alignItems: 'flex-start'");
    expect(styleBlock(source, 'empty')).toContain('paddingHorizontal: hull.space.lg');
    expect(styleBlock(source, 'header')).toContain('paddingLeft: hull.space.lg');
    expect(styleBlock(source, 'header')).toContain('paddingRight: 16');
    expect(styleBlock(source, 'empty')).not.toMatch(/\bpadding: \d/);
    expect(styleBlock(source, 'emptyTitle')).toContain('...hull.type.body,');
    expect(styleBlock(source, 'emptyTitle')).toContain('color: hull.textPrimary');
    expect(styleBlock(source, 'emptyCopy')).toContain('...hull.type.meta,');
    expect(styleBlock(source, 'emptyCopy')).toContain('color: hull.ledgerQuiet');
    expect(styleBlock(source, 'emptyCopy')).toContain('maxWidth: 330');
    expect(styleBlock(source, 'emptyActionList')).toContain("flexDirection: 'row'");
    expect(styleBlock(source, 'emptyActionList')).toContain('gap: 10');
    expect(styleBlock(source, 'emptyActionList')).toContain('marginTop: hull.space.md');
    expect(styleBlock(source, 'emptyButton')).toContain('height: 44');
    expect(styleBlock(source, 'emptyButton')).toContain('paddingHorizontal: hull.space.md');
    expect(styleBlock(source, 'emptyButton')).toContain('borderWidth: 1');
    expect(styleBlock(source, 'emptyButton')).toContain('borderColor: hull.borderStrong');
    expect(styleBlock(source, 'emptyButton')).toContain('borderRadius: 10');
    expect(styleBlock(source, 'emptyButton')).not.toContain('backgroundColor');
    expect(styleBlock(source, 'emptyButtonPressed')).toContain('backgroundColor: hull.bgPressed');
    expect(styleBlock(source, 'emptyPrimaryLabel')).toContain("Typography.ledger('medium')");
    expect(styleBlock(source, 'emptyPrimaryLabel')).toContain('color: hull.accent');
    expect(styleBlock(source, 'emptySecondaryLabel')).toContain('...Typography.ledger()');
    expect(styleBlock(source, 'emptySecondaryLabel')).toContain('color: hull.ledgerQuiet');
    for (const name of [
      'empty',
      'emptyTitle',
      'emptyCopy',
      'emptyActionList',
      'emptyButton',
      'emptyButtonPressed',
      'emptyPrimaryLabel',
      'emptySecondaryLabel',
    ]) {
      expect(styleBlock(source, name), name).not.toMatch(
        /fontSize:\s*\d|letterSpacing|textTransform/,
      );
    }
    const emptyDeck = source.slice(
      source.indexOf('function EmptyRoomActions'),
      source.indexOf('function firstParam'),
    );
    expect(emptyDeck).toContain('>No Rooms yet</Text>');
    expect(emptyDeck).toContain(
      'A Room holds one repository and the people and agents working on it.',
    );
    expect(emptyDeck).toContain('>Start a Room</Text>');
    expect(emptyDeck).toContain('>Connect an agent</Text>');
    expect(emptyDeck.match(/accessibilityRole="button"/g)).toHaveLength(2);
    expect(emptyDeck.match(/styles\.emptyButtonPressed/g)).toHaveLength(2);
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

  it('keeps DM presence out of list rows', () => {
    expect(source).not.toContain('directMessagePresence');
    expect(source).not.toContain('presenceCaption');
    expect(source).not.toContain('presenceDot');
    expect(source).not.toContain('room-presence-');
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
      "import { cornerDisplayItems, cornerDisplayState } from '@/buzz/corner-display-state';",
    );
    expect(source).toContain('const display = cornerDisplayState(corner);');
    expect(source).toContain('cornerDisplayItems(corners).map((entry) => entry.item)');
    // The old collapses: a raw lifecycle word as the status, and a filter that
    // read `lifecycle` while the row's count read the daemon.
    expect(source).not.toContain('cornerStatusWord');
    expect(source).not.toContain("lifecycle.lifecycle !== 'done'");
  });

  it('pulses bright working ink and spends still brass only on waiting corner state', () => {
    expect(source).toContain("display.status === 'working'");
    expect(source).toContain("display.status === 'review'");
    expect(source).toContain("display.status === 'archived'");
    expect(source).toContain('display.needsYou && styles.cornerNameNeedsYou');
    expect(source).toContain('<CornerWorkingPulse state={display.status}>');
    expect(source).toContain('</CornerWorkingPulse>');
    expect(styleBlock(source, 'cornerStatusWorking')).toContain('color: hull.ledgerBright');
    expect(styleBlock(source, 'cornerStatusReview')).toContain('color: hull.ledgerQuiet');
    expect(styleBlock(source, 'cornerStatusWaiting')).toContain('color: hull.accent');
    expect(styleBlock(source, 'cornerStatusArchived')).toContain('color: hull.ledgerGhost');
    expect(styleBlock(source, 'cornerNameNeedsYou')).toContain('color: hull.textPrimary');
    expect(styleBlock(source, 'cornerName')).toContain('color: hull.textSecondary');
    expect(source).toContain("display.needsYou ? ', needs you' : ''");

    expect(styleBlock(desktopInspectorSource, 'cornerStatusWorking', '  ')).toContain(
      'color: theme.buzz.ledgerQuiet',
    );
    expect(styleBlock(desktopInspectorSource, 'cornerStatusReview', '  ')).toContain(
      'color: theme.buzz.ledgerQuiet',
    );
    expect(styleBlock(desktopInspectorSource, 'cornerStatusWaiting', '  ')).toContain(
      'color: theme.buzz.accent',
    );
    expect(styleBlock(cornerHeaderSource, 'cornerHeaderWorking')).toContain(
      'color: groknight.ledgerQuiet',
    );
    expect(styleBlock(cornerHeaderSource, 'cornerHeaderReview')).toContain(
      'color: groknight.ledgerQuiet',
    );
    expect(styleBlock(cornerHeaderSource, 'cornerHeaderWaiting')).toContain(
      'color: groknight.accent',
    );
    expect(cornerListSource).toContain('<RoomCornersList');
    expect(roomCornersListSource).toContain("from '@/buzz/inspector-corners'");
    expect(roomCornersListSource).toContain(
      '<StateCircle state={display.visual} tone={display.tone} />',
    );
  });

  it('centers the corner title, every state word, and chevron on one line', () => {
    // These are direct children of one centered flex row. No nested endcap gets
    // centered independently from the title, and no glyph carries a vertical nudge.
    const phoneRowStart = source.lastIndexOf(
      '<TouchableOpacity',
      source.indexOf('testID={`room-corner-${corner.corner.id}`}'),
    );
    const phoneRow = source.slice(
      phoneRowStart,
      source.indexOf('</TouchableOpacity>', phoneRowStart),
    );
    expect(phoneRow).not.toContain('cornerEndcap');
    expect(phoneRow.match(/<Text\b/g)).toHaveLength(3);
    expect(phoneRow).toContain('styles.cornerTrail');
    expect(styleBlock(source, 'cornerRow')).toContain("alignItems: 'center'");
    expect(styleBlock(source, 'cornerTrail')).toContain("alignItems: 'center'");
    expect(styleBlock(source, 'cornerChevron')).toContain('...theme.buzz.type.sectionHead');

    const desktopHeadlineStart = desktopInspectorSource.indexOf(
      '<View style={styles.cornerHeadline}>',
    );
    const desktopHeadline = desktopInspectorSource.slice(
      desktopHeadlineStart,
      desktopInspectorSource.indexOf('</View>', desktopHeadlineStart),
    );
    expect(desktopHeadline.match(/<Text\b/g)).toHaveLength(4);
    expect(desktopHeadline).toContain('{display.word}');
    expect(styleBlock(desktopInspectorSource, 'cornerHeadline', '  ')).toContain(
      "alignItems: 'center'",
    );

    for (const [text, indent, styles] of [
      [source, '    ', ['cornerName', 'cornerStatus', 'cornerChevron']],
      [desktopInspectorSource, '  ', ['cornerTitle', 'cornerStatus', 'cornerMe', 'chevron']],
    ] as const) {
      for (const style of styles) {
        const block = styleBlock(text, style, indent);
        expect(block, style).toContain('includeFontPadding: false');
        expect(block, style).not.toMatch(/\b(?:margin|padding|top|bottom|transform):/);
      }
    }

    // Both headline faces are Space Grotesk. Read its OpenType cap height and
    // typographic extents, then compare their rendered cap centers at the role
    // sizes (meta 13px title, section-head 10px label).
    const titleCapCenter = capCenterOffset(cornerTitleTypeface, 13);
    const labelCapCenter = capCenterOffset(cornerLabelTypeface, 10);
    expect(Math.abs(titleCapCenter - labelCapCenter)).toBeLessThanOrEqual(1);
  });
});
