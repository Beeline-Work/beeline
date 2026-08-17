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

  it('spends the gold accent only on genuinely live corner work', () => {
    // DESIGN.md fixes gold to agent identity, live/online presence, owner role,
    // and merge approval. Unread and attention states here must carry on weight
    // and luminance instead, so this screen has exactly three accent uses: the
    // Room row's live glyph, the live corner's glyph, and the live-count in the
    // section heading — each redundant with a glyph or the LIVE wave label.
    const accentStyles = [...source.matchAll(/ {2}([A-Za-z0-9_]+): \{[^}]*groknight\.accent/g)].map(
      (match) => match[1],
    );
    expect(accentStyles.sort()).toEqual(['cornerGlyphLive', 'indexSignalCount', 'roomGlyphLive']);
    expect(styleBlock(source, 'rowUnread')).not.toMatch(/accent/);
    expect(styleBlock(source, 'rowTitleUnread')).not.toMatch(/accent/);
  });

  it('shows a human preview line, never raw plumbing or a placeholder id', () => {
    // The preview is whatever `roomPreviewText` sanitized at ingest; the row
    // must not re-derive or re-format message content itself.
    expect(source).toContain('item.latestMessage ??');
    // No slicing, splitting, or rewriting of message text on this screen — the
    // one sanitizer is `roomPreviewText`, applied where the preview is stored.
    expect(source).not.toMatch(/latestMessage[^\n]*\.(?:slice|split|replace|substring)\(/);
    expect(source).not.toMatch(/latestMessage[^\n]*(?:hint:|\[rejected\])/);
  });

  it('attributes the preview with the same identity waterfall the rest of the app uses', () => {
    expect(source).toContain('previewAuthorLabel(');
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
    // listed. `roomListCorners` is the single filter, and both the count and the
    // dropdown map over its result — nothing else may compute a corner total.
    expect(source).toContain('const corners = roomListCorners(item.corners ?? []);');
    expect(source).toContain('const canExpand = corners.length > 0;');
    expect(source).toContain('{corners.length}');
    expect(source).toContain('{corners.map((corner) => {');
    expect(source).not.toMatch(/item\.corners(?:\s*\?\?\s*\[\])?\.length/);
  });

  it('offers the full corner list as the way to reach excluded corners', () => {
    expect(source).toContain('/buzz/corners/${encodeURIComponent(item.id)}');
  });

  it('keeps 44pt touch targets on every index control', () => {
    for (const name of ['headerAction', 'indexRow', 'cornerPeek', 'cornerRow']) {
      expect(styleBlock(source, name)).toMatch(/min(?:Width|Height): (?:4[4-9]|[5-9]\d)/);
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

  it('renders every identity in the chrome as a faceted mark', () => {
    expect(railSource).toContain('<WorkspaceAvatar');
    expect(railSource).toContain('<PersonAvatar');
    expect(railSource).not.toMatch(/borderRadius: \d*size|borderRadius: '50%'/);
  });
});
