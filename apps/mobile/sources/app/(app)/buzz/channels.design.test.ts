import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design invariants for the Room list — the index the whole product opens on.
 * These are source assertions, in the same style as `channels.members.test.ts`,
 * because what they lock in is structural: which shared primitive renders a
 * thing, and which shapes must never come back. DESIGN.md (repo root) is the
 * authority they encode.
 */
const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const railSource = readFileSync(
  path.join(__dirname, '../../../components/buzz/CommunityRail.tsx'),
  'utf8',
);

function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`  ${name}: {`);
  expect(start, `missing style ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unclosed style ${name}`);
}

/** Every style that renders a repeating index unit: a Room row, a DM row, the
 * expanded corner rows, and their leading marks. None may become a box. */
const REPEATING_ROW_STYLES = [
  'indexRow',
  'roomCell',
  'roomRow',
  'roomPrimary',
  'rowMark',
  'rowCopy',
  'rowTitleLine',
  'rowGutter',
  'cornerRow',
  'cornerDropdown',
  'cornerPeek',
];

describe('Room list — Grok Mono Hull invariants', () => {
  it('never draws a box around a repeating row, mark, or the corner dropdown', () => {
    for (const name of REPEATING_ROW_STYLES.filter((name) => name !== 'roomCell')) {
      const block = styleBlock(source, name);
      expect(block, `${name} must not have a radius`).not.toMatch(/borderRadius/);
      expect(block, `${name} must not be a bordered container`).not.toMatch(/borderWidth/);
      expect(block, `${name} must not draw an inline border`).not.toMatch(
        /border(?:Top|Bottom|Left|Right)(?:Width|Color)/,
      );
    }
    expect(styleBlock(source, 'roomCell')).toMatch(/borderBottomWidth:\s*1/);
    expect(styleBlock(source, 'roomCell')).toMatch(/borderBottomColor:\s*groknight\.border/);
  });

  it('routes buttons, reveal, press, and the deck mark through shared MonoHull primitives', () => {
    for (const primitive of [
      'BrittlePress',
      'HullDeckMark',
      'MonoButton',
      'PixelGateReveal',
      'PixelLoader',
    ]) {
      expect(source, `${primitive} should come from MonoHull`).toContain(primitive);
    }
    // No screen-local button styles competing with MonoButton.
    expect(source).not.toMatch(/ {2}primary(?:Small)?Button: \{/);
  });

  it('gives the persistent chrome no surface of its own', () => {
    // The obsidian slab is unbroken: a header or rail that carried its own
    // textured HullSurface read as a plate laid on top of the screen. Both are
    // now the same bare surface as the list, parted by one hairline. A
    // genuinely lifted, non-repeating region (a modal, the merge-approval
    // panel) still earns HullSurface — persistent chrome does not.
    for (const [name, text] of [
      ['channels.tsx', source],
      ['CommunityRail.tsx', railSource],
    ] as const) {
      expect(text, `${name} chrome should not mount HullSurface`).not.toContain('<HullSurface');
    }
    expect(styleBlock(source, 'header')).toMatch(/borderBottomColor:\s*groknight\.border/);
    expect(styleBlock(railSource, 'rail')).toMatch(
      /borderRightWidth: StyleSheet\.hairlineWidth/,
    );
    // A row declares no surface of its own either — the slab shows through.
    expect(styleBlock(source, 'roomCell')).not.toMatch(/backgroundColor/);
  });

  it('sources every color from the groknight token file', () => {
    // No hex, rgb(), or rgba() literal anywhere in the screen.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(railSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(railSource).not.toMatch(/rgba?\(/);
  });

  it('keeps the one radius value wherever a box is still earned', () => {
    for (const text of [source, railSource]) {
      for (const match of text.matchAll(/borderRadius: (\d+)/g)) {
        expect(match[1], 'only groknight.radius (3) ships').toBe('3');
      }
    }
  });

  it('spends brass ONLY on needs-you rows — the deck\u2019s whole point', () => {
    // The supervision deck's one rule: the accent appears on a needs-you row's
    // rail and its activity line — there are no pills anymore, so the brass
    // mark plus the accent fact line carry the whole "needs you" signal.
    // Working is motion; idle and unread are steel/luminance.
    const accentStyles = [...source.matchAll(/ {2}([A-Za-z0-9_]+): \{[^}]*groknight\.accent/g)].map(
      (match) => match[1],
    );
    expect(accentStyles.sort()).toEqual([
      'attnRail',
      'cornerPeekCountLive',
      'fab',
      'rowPreviewAttention',
    ]);
    // Every accent style on a ROW is gated by the derived needs-you flag (the
    // FAB is an action surface, `indexSignalCount`/`cornerPeekCountLive` are
    // the heading's LIVE count and the dropdown's live count). The expansion
    // rows' live glyph color lives in MonoHull's shared CornerGlyph.
    expect(source).toContain("row.attention && <View pointerEvents=\"none\" style={styles.attnRail} />");
    expect(source).toContain('row.attention && styles.rowPreviewAttention');
    expect(source).toContain('row.attention && styles.cornerPeekCountLive');
    // Corner state glyphs render through THE one shared diamond component —
    // never a screen-local Text with an identity shape.
    expect(source).toContain('<CornerGlyph status={corner.status} style={styles.cornerGlyph} />');
    // No pill strip came back: the cell renders mark + name + fact + count,
    // and nothing else.
    expect(source).not.toMatch(/styles\.pillStrip|styles\.rowPill/);
    expect(source).not.toContain('styles.unreadRail');
  });

  it('renders the three deck states through one HullDeckMark driven by the projection', () => {
    // needs-you > working > idle is decided in `roomRowPresentation`; the
    // screen only maps the answer onto the shared three-state mark.
    expect(source).toMatch(/row\.attention\s*\?\s*'needs-you'\s*:\s*row\.zone === 'working'\s*\?\s*'working'\s*:\s*'idle'/);
    expect(source).toContain('<HullDeckMark state={deckState} />');
    // No screen-local spinner or pulse: motion lives in MonoHull.
    expect(source).not.toMatch(/withRepeat|useSharedValue/);
  });

  it('reads on exactly three tones: name, activity line, gutter marginalia', () => {
    // The ledger's luminance ladder at index scale. The name is the brightest
    // thing on the row; the activity line sits a step down; everything the
    // right gutter carries is ghosted.
    expect(styleBlock(source, 'rowTitle')).toContain('groknight.textPrimary');
    expect(styleBlock(source, 'rowPreview')).toContain('groknight.ledgerQuiet');
    for (const name of ['rowAge', 'cornerPeekCount']) {
      expect(styleBlock(source, name), `${name} belongs to the ghosted tier`).toContain(
        'groknight.ledgerGhost',
      );
    }
    // Names are always semibold Space Grotesk 16; read DMs dim one tone.
    expect(styleBlock(source, 'rowTitle')).toContain("Typography.default('semiBold')");
    expect(styleBlock(source, 'rowTitle')).toContain('fontSize: 16');
    expect(styleBlock(source, 'rowTitleRead')).toContain('groknight.textSecondary');
    // The repo tag rides the title line in mono.
    expect(styleBlock(source, 'rowRepo')).toMatch(/Typography\.mono\(/);
  });

  it('hangs every row\u2019s metadata in one fixed right gutter \u2014 in flow, never absolute', () => {
    // Marginalia, exactly as the transcript does it: a fixed-width column, so
    // an age stamp or a corner count can never reflow the copy beside it, and
    // every row reserves the column whether or not it has one. It MUST be an
    // in-flow flex sibling (never absolutely positioned over the row): an
    // overlay cannot contribute height, and a fixed row height under tall copy
    // is how the first ship of this deck painted rows over their neighbours.
    const gutter = styleBlock(source, 'rowGutter');
    expect(gutter).not.toMatch(/position: 'absolute'/);
    expect(gutter).toContain('width: ROW_GUTTER_WIDTH');
    expect(gutter).toContain('flexShrink: 0');
    expect(gutter).toMatch(/alignItems: 'flex-end'/);
    expect(styleBlock(source, 'indexRow')).toContain('paddingRight: SCREEN_INSET');
    expect(styleBlock(source, 'indexRow')).not.toContain(
      'paddingRight: SCREEN_INSET + ROW_GUTTER_WIDTH',
    );
    // The stamp lives in the gutter, never back on the name's own line.
    expect(styleBlock(source, 'rowAge')).not.toContain("marginLeft: 'auto'");
    expect(source).toContain('<View style={styles.rowGutter}>');
    expect(source).not.toContain('pointerEvents="box-none" style={styles.rowGutter}');
    // Rooms and DMs use the same cell, the same gutter, and the same divider.
    expect(source.match(/style=\{styles\.rowGutter\}/g)).toHaveLength(2);
    expect(source.match(/style=\{styles\.roomCell\}/g)).toHaveLength(2);
  });

  it('rows are self-sizing flex containers — the overlap regression stays dead', () => {
    // The first ship of this deck gave every row a FIXED height (72) while
    // rows carry title + preview + pills, so tall content overflowed its cell
    // and painted over the neighbouring row. The row must establish its own
    // height from in-flow children: a minHeight floor, never a fixed height.
    const indexRow = styleBlock(source, 'indexRow');
    expect(indexRow).toContain('minHeight: INDEX_ROW_HEIGHT');
    expect(indexRow).not.toMatch(/\bheight:\s*(?:INDEX_ROW_HEIGHT|\d)/);
    expect(indexRow).toContain("flexDirection: 'row'");
    // The status mark is a fixed-width FLEX column inside the row, never an
    // absolutely positioned layer over it. Its box is exactly the name's line
    // height (lineHeight 21) with the mark centered in it, so the dot/ring
    // aligns TO the name instead of floating above it.
    const rowMark = styleBlock(source, 'rowMark');
    expect(rowMark).not.toMatch(/position: 'absolute'/);
    expect(rowMark).toContain('width: ROW_MARK_WIDTH');
    expect(rowMark).toContain('height: 21');
    expect(rowMark).toContain("justifyContent: 'center'");
    expect(rowMark).not.toMatch(/paddingTop/);
    expect(source).toContain(
      '<View style={styles.rowMark}>\n                <HullDeckMark state={deckState} />',
    );
    // The repo tag rides the title line via flex (marginLeft auto), not via
    // absolute placement.
    const repo = styleBlock(source, 'rowRepo');
    expect(repo).toContain("marginLeft: 'auto'");
    expect(repo).not.toMatch(/position: 'absolute'/);
    // The brass rail is the ONE absolute layer left on a row cell, and it is
    // an edge decoration bounded by the cell's own box (top/bottom/left/width,
    // no negative offsets), so it can never escape into a neighbouring row.
    const rail = styleBlock(source, 'attnRail');
    expect(rail).toMatch(/width: 2/);
    expect(rail).not.toMatch(/-(?:top|left|right|bottom)/);
  });

  it('shows the projected current fact, never raw plumbing or a placeholder id', () => {
    // The projection chooses lifecycle truth first and a sanitized message
    // only as its fallback; the row renders that answer directly.
    expect(source).toContain('{row.fact}');
    // No slicing, splitting, or rewriting of message text on this screen — the
    // one sanitizer is `roomPreviewText`, applied where the preview is stored.
    expect(source).not.toMatch(/latestMessage[^\n]*\.(?:slice|split|replace|substring)\(/);
    expect(source).not.toMatch(/latestMessage[^\n]*(?:hint:|\[rejected\])/);
  });

  it('attributes lifecycle facts with the same identity waterfall the rest of the app uses', () => {
    expect(source).toContain('roomListSections(visible, authorNames, { now: ageNow })');
    expect(source).toContain("names.set(identity.publicKey, 'You')");
  });

  it('drops the #-prefixed corner naming DESIGN.md retired', () => {
    expect(source).not.toContain('#${corner.name}');
    expect(source).not.toContain('└');
    // ...and never reintroduces a `#` in front of a Room title either.
    expect(source).not.toMatch(/>#\{/);
  });

  it('renders the corner count from exactly the corners the dropdown lists', () => {
    // Captain's hard requirement: only open/active corners are counted and
    // listed. `roomRowPresentation` resolves that one set through
    // `roomListCorners`, and both the count and the dropdown read its result —
    // nothing on this screen may compute a corner total of its own. Finished
    // corners are represented NOWHERE: no recorded-total fallback count, and
    // no expansion affordance when nothing is open.
    expect(source).toContain('const corners = row.corners;');
    expect(source).toContain('const canExpand = corners.length > 0;');
    expect(source).toContain('{corners.length}');
    expect(source).toContain('{corners.map((corner) => {');
    expect(source).not.toContain('totalCorners');
    expect(source).not.toContain('roomListCorners(');
    expect(source).not.toMatch(/item\.corners(?:\s*\?\?\s*\[\])?\.length/);
  });

  it('opens a Room’s corners inline from its contained count control', () => {
    expect(source).toContain('testID={`room-corners-toggle-${item.id}`}');
    expect(source).toContain('accessibilityState={{ expanded }}');
    expect(source).toContain(
      'setExpandedRoomId((current) => (current === item.id ? null : item.id))',
    );
    expect(source).toContain('{expanded && (');
    expect(source).toContain('{corners.map((corner) => {');
    // The expansion IS the full list of open work: no trailing All Corners
    // row was re-added after it.
    expect(source).not.toContain('room-all-corners');
    expect(source).not.toContain('cornerPeekCaret');
    expect(styleBlock(source, 'cornerPeek')).toContain("flexDirection: 'row'");
    expect(styleBlock(source, 'cornerPeek')).toContain("alignItems: 'center'");
  });

  it('shows unread as a quiet gray pill, and reserves the left rail for needs-you', () => {
    // The old solid-gold unread rail is gone: brass means only needs-you now.
    // A needs-you Room carries the 2px accent edge instead, gated on the same
    // derived flag as the status pill.
    expect(styleBlock(source, 'attnRail')).toContain('groknight.accent');
    expect(styleBlock(source, 'attnRail')).toContain('left: 0');
    expect(styleBlock(source, 'attnRail')).not.toContain('width: 3');
    expect(source).not.toContain('styles.rowUnread');
  });

  it('closes the deck with just the brass FAB — the search field stays gone', () => {
    // Captain's call: a supervision deck holds few rooms, so search was dead
    // weight. The field, its state, its filter helper, and its style must not
    // come back — and nothing else in the index may grow a second filter.
    expect(source).not.toContain('room-search');
    expect(source).not.toContain('searchField');
    expect(source).not.toContain('matchesSearch');
    expect(source).not.toMatch(/searchQuery|setSearchQuery/);
    // The FAB stays wired and opens the same create panel as the header
    // affordance.
    expect(source).toContain('testID="create-room-fab"');
    expect(source).toContain('onPress={() => setShowCreateChannel(true)}');
    expect(styleBlock(source, 'fab')).toMatch(/(?:width|minHeight): 44/);
  });

  it('renders exactly two inline tiers plus the collapsed FINISHED entry', () => {
    // Owner spec 2026-08-23: attention-state and recency were semantically
    // different tiers; the deck has exactly TWO section labels — NEEDS YOU
    // (actionable corner work) then IDLE (every other visible Room, working
    // ones included; the row marks already convey working vs quiet). No
    // recency headings, no third top-level tier. The labels themselves are
    // pinned by room-list-row.test.ts against the projection; this screen
    // must render them verbatim from that one source, never re-derive a
    // vocabulary of its own.
    expect(source).toContain("from '@/buzz/room-list-row'");
    expect(source).toContain('{section.title} · {section.data.length}');
    expect(source).toContain('<SectionList');
    expect(source).toContain('sections={roomSections.sections}');
    expect(source).toContain('stickySectionHeadersEnabled={false}');
    expect(source).not.toContain("section.zone === 'working'");
    for (const retired of ["'WORKING'", "'TODAY'", "'YESTERDAY'", "'EARLIER'"]) {
      expect(source, `${retired} must not come back as a tier label`).not.toContain(retired);
    }
    // Finished Rooms are one-depth-hidden: a single collapsed header row at
    // the bottom that expands to the finished list — never rendered inline by
    // any tier.
    expect(source).toContain('FINISHED ·');
    expect(source).toContain('testID="finished-rooms-toggle"');
    expect(source).toContain('accessibilityState={{ expanded: showFinishedRooms }}');
    expect(source).toContain('showFinishedRooms &&');
    expect(source).toContain('renderRoomEntry(entry)');
  });

  it('keeps the expansion as the only in-index corner list — no duplicate route link', () => {
    // The All Corners row was removed: the expanded dropdown already lists
    // the Room's open corners, so a second link into the same list was
    // redundant. Nothing in the index navigates to the standalone corners
    // screen anymore — that surface remains reachable from elsewhere.
    expect(source).not.toContain('/buzz/corners/');
  });

  it('keeps 44pt touch targets on every index control', () => {
    /** A minimum written either as a literal or as one of the screen's own
     * layout constants — both are real, and the constant is what a row height
     * shared by every row in the index should be. */
    const minimumTouchSize = (name: string): number => {
      const written = [
        ...styleBlock(source, name).matchAll(/min(?:Width|Height): ([A-Z_0-9]+|\d+)/g),
      ].map((match) => match[1]);
      expect(written.length, `${name} declares no minimum size`).toBeGreaterThan(0);
      const values = written.map((token) => {
        if (/^\d+$/.test(token)) return Number(token);
        const declared = source.match(new RegExp(`const ${token} = (\\d+);`))?.[1];
        expect(declared, `${name} references an undeclared ${token}`).toBeTruthy();
        return Number(declared);
      });
      // `minWidth: 0` is a flex guard, not a touch bound — the target is the
      // largest minimum the style declares.
      return Math.max(...values);
    };
    for (const name of ['headerAction', 'indexRow', 'cornerPeek', 'cornerRow']) {
      expect(minimumTouchSize(name), `${name} is under the 44pt floor`).toBeGreaterThanOrEqual(44);
    }
    for (const name of ['railButtonSlot', 'railCommand', 'drawerTrigger']) {
      expect(styleBlock(railSource, name)).toMatch(/(?:height|minHeight): (?:4[4-9]|[5-9]\d)/);
    }
  });
});

describe('Workspace rail and chrome — Grok Mono Hull invariants', () => {
  it('gives the Workspace switcher a single press target, not two doing the same thing', () => {
    expect(railSource.match(/testID="workspace-avatar-trigger"/g)).toHaveLength(1);
    expect(railSource).not.toContain('community-drawer-trigger');
    expect(railSource).toContain('testID="workspace-avatar-header"');
    // The screen no longer prints its own Workspace title beside the trigger.
    expect(source).not.toContain('styles.headerTitle');
  });

  it('names every rail command instead of framing it in a box', () => {
    for (const name of ['railButton', 'railCommand', 'railCommandLabel']) {
      const block = styleBlock(railSource, name);
      expect(block, `${name} must not be a box`).not.toMatch(/borderWidth|borderRadius/);
    }
    expect(railSource).not.toContain("borderStyle: 'dashed'");
    for (const label of ['"ADD"', '"SETUP"', '"YOU"']) {
      expect(railSource, `rail command ${label} needs a mono label`).toContain(`label=${label}`);
    }
  });

  it('marks the selected Workspace with an edge bar rather than a floating bracket', () => {
    expect(railSource).toContain('styles.selectionBar');
    expect(railSource).not.toContain('activeNotch');
    expect(styleBlock(railSource, 'selectionBar')).toContain('groknight.selectedBorder');
  });

  it('renders every identity in the chrome through the one identity mark', () => {
    // Shape reports the type — ▢ for a Workspace, ○ for a person — and both
    // come out of the single `IdentityMark` primitive, never a rail-local one.
    expect(railSource).toMatch(/<IdentityMark\s+kind="workspace"/);
    expect(railSource).toMatch(/<IdentityMark\s+kind="human"/);
    expect(railSource).not.toMatch(/AgentAvatar|PersonAvatar|WorkspaceAvatar/);
    expect(railSource).not.toMatch(/borderRadius: \d*size|borderRadius: '50%'/);
  });

  it('distinguishes the active Workspace by tone, never by a fill behind it', () => {
    // Selection is redundantly encoded — edge bar, the mark's own heavier
    // frame, and tone — and none of those three is a background plate.
    expect(railSource).toContain('!active && styles.railButtonIdle');
    expect(styleBlock(railSource, 'railButtonIdle')).toMatch(/opacity: 0\.\d+/);
    for (const name of ['railButton', 'railButtonIdle', 'railButtonSlot']) {
      expect(styleBlock(railSource, name), `${name} must not fill`).not.toMatch(/backgroundColor/);
    }
  });

  it('keeps the header a Workspace name plus quiet named affordances', () => {
    // The Workspace name is the anchor; Members and ＋Room sit a tier below it
    // rather than competing for the top of the ladder.
    expect(styleBlock(railSource, 'drawerTriggerName')).toContain('groknight.textPrimary');
    expect(styleBlock(source, 'headerActionText')).toContain('groknight.textMuted');
    expect(styleBlock(railSource, 'railCommandGlyph')).toContain('groknight.textSecondary');
  });

  it('opens one coherent settings surface rather than skipping past the hub', () => {
    expect(source).toContain("onSettings={() => router.push('/buzz/settings' as Href)}");
    expect(source).not.toContain("router.push('/buzz/settings/identity'");
  });
});
