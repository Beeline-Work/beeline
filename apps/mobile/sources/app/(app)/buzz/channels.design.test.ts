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
    for (const name of REPEATING_ROW_STYLES) {
      const block = styleBlock(source, name);
      expect(block, `${name} must not have a radius`).not.toMatch(/borderRadius/);
      expect(block, `${name} must not be a bordered container`).not.toMatch(/borderWidth/);
      // A hairline divider is the one separator a list row may carry, and it is
      // only ever the shared `hairlineDivider` — never a hand-rolled border.
      expect(block, `${name} must use hairlineDivider, not an inline border`).not.toMatch(
        /border(?:Top|Bottom|Left|Right)(?:Width|Color)/,
      );
    }
    expect(source).toContain('...hairlineDivider');
  });

  it('routes buttons, reveal, press, and the live signal through shared MonoHull primitives', () => {
    for (const primitive of [
      'BrittlePress',
      'HullLivePulse',
      'HullWaveSignal',
      'MonoButton',
      'PixelGateReveal',
      'PixelLoader',
      'hairlineDivider',
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
    expect(styleBlock(source, 'header')).toMatch(/hairlineDivider/);
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

  it('spends the gold accent only on genuinely live agent work', () => {
    // Gold means exactly one thing product-wide: an agent is alive and working.
    // On this screen that is a Room with a live corner — the row's ◆ glyph, its
    // corner count, the corner's own glyph in the dropdown, and the live tally
    // in the section heading. Everything else, unread and needs-attention
    // included, escalates on weight and luminance instead.
    const accentStyles = [...source.matchAll(/ {2}([A-Za-z0-9_]+): \{[^}]*groknight\.accent/g)].map(
      (match) => match[1],
    );
    expect(accentStyles.sort()).toEqual([
      'cornerGlyphLive',
      'cornerPeekCountLive',
      'indexSignalCount',
      'roomGlyphLive',
    ]);
    for (const name of ['rowUnread', 'rowTitleUnread', 'roomGlyphAttention', 'rowAgeUnread']) {
      expect(styleBlock(source, name), `${name} must not take gold`).not.toMatch(/accent/);
    }
    // Every gold mark on a row is driven by the same derived `live` flag, so a
    // Room that is merely unread or merely busy can never pick it up.
    expect(source).toContain('live && styles.roomGlyphLive');
    expect(source).toContain('row.live && styles.cornerPeekCountLive');
    expect(source).toContain('<RoomRowMark attention={row.attention} glyph={row.glyph} live={row.live} />');
  });

  it('runs the live pulse only on a Room that is actually live', () => {
    // The gold ◆ breathes; a quiet row must not pay for an animation clock it
    // never uses, and the mark stays memoized so a list-level state change
    // (presence, the age tick) cannot rebuild every row's glyph.
    expect(source).toContain('const RoomRowMark = React.memo(');
    expect(source).toContain('if (!live) return <View style={styles.rowMark}>{mark}</View>;');
    expect(source).toContain('<HullLivePulse active style={styles.rowMark}>');
  });

  it('reads on exactly three tones: name, activity line, gutter marginalia', () => {
    // The ledger's luminance ladder at index scale. The name is the brightest
    // thing on the row; the activity line sits a step down; everything the
    // right gutter carries is ghosted.
    expect(styleBlock(source, 'rowTitle')).toContain('groknight.textPrimary');
    expect(styleBlock(source, 'rowPreview')).toContain('groknight.ledgerQuiet');
    for (const name of ['rowAge', 'cornerPeekCount', 'cornerPeekCaret']) {
      expect(styleBlock(source, name), `${name} belongs to the ghosted tier`).toContain(
        'groknight.ledgerGhost',
      );
    }
    // Unread spends the index's one weight step plus one luminance step — it is
    // the only place on this screen weight is spent at all.
    expect(styleBlock(source, 'rowTitle')).toContain('Typography.default()');
    expect(styleBlock(source, 'rowTitleUnread')).toContain("Typography.default('semiBold')");
    expect(styleBlock(source, 'rowTitleUnread')).toContain('groknight.ledgerBright');
  });

  it('hangs every row\u2019s metadata in one fixed right gutter', () => {
    // Marginalia, exactly as the transcript does it: absolutely positioned at a
    // fixed width, so an age stamp or a corner count can never reflow the copy
    // beside it, and every row reserves the column whether or not it has one.
    const gutter = styleBlock(source, 'rowGutter');
    expect(gutter).toMatch(/position: 'absolute'/);
    expect(gutter).toContain('width: ROW_GUTTER_WIDTH');
    expect(gutter).toMatch(/alignItems: 'flex-end'/);
    expect(styleBlock(source, 'indexRow')).toContain(
      'paddingRight: SCREEN_INSET + ROW_GUTTER_WIDTH',
    );
    // The stamp lives in the gutter, never back on the name's own line.
    expect(styleBlock(source, 'rowAge')).not.toContain("marginLeft: 'auto'");
    expect(source).toContain('<View pointerEvents="box-none" style={styles.rowGutter}>');
    // Rooms and DMs use the same cell, the same gutter, and the same divider.
    expect(source.match(/style=\{styles\.rowGutter\}/g)).toHaveLength(2);
    expect(source.match(/style=\{styles\.roomCell\}/g)).toHaveLength(2);
  });

  it('shows a human preview line, never raw plumbing or a placeholder id', () => {
    // The preview is whatever `roomPreviewText` sanitized at ingest; the row
    // must not re-derive or re-format message content itself.
    expect(source).toContain('{row.preview}');
    // No slicing, splitting, or rewriting of message text on this screen — the
    // one sanitizer is `roomPreviewText`, applied where the preview is stored.
    expect(source).not.toMatch(/latestMessage[^\n]*\.(?:slice|split|replace|substring)\(/);
    expect(source).not.toMatch(/latestMessage[^\n]*(?:hint:|\[rejected\])/);
  });

  it('attributes the preview with the same identity waterfall the rest of the app uses', () => {
    expect(source).toContain('roomRowPresentation(item, authorNames)');
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
    // nothing on this screen may compute a corner total of its own.
    expect(source).toContain('const corners = row.corners;');
    expect(source).toContain('const canExpand = corners.length > 0;');
    expect(source).toContain('{corners.length}');
    expect(source).toContain('{corners.map((corner) => {');
    expect(source).not.toContain('roomListCorners(');
    expect(source).not.toMatch(/item\.corners(?:\s*\?\?\s*\[\])?\.length/);
  });

  it('offers the full corner list as the way to reach excluded corners', () => {
    expect(source).toContain('/buzz/corners/${encodeURIComponent(item.id)}');
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
      expect(styleBlock(railSource, name), `${name} must not fill`).not.toMatch(
        /backgroundColor/,
      );
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
