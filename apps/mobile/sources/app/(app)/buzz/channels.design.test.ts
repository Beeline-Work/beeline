import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const composeSource = readFileSync(
  new URL('../../../components/buzz/RoomDeckComposeMenu.tsx', import.meta.url),
  'utf8',
);
const roomViewSource = readFileSync(
  new URL('../../../../../../packages/buzz-client/src/room-view.ts', import.meta.url),
  'utf8',
);
const surfaceGuardSource = readFileSync(
  new URL('../../../../../../packages/buzz-client/src/surface-guards.ts', import.meta.url),
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
  it('floats the compose button over the scrolling list at the bottom right', () => {
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
    // The compose button matches the deck's 48px rail controls. Its plus is a
    // geometric SVG, so Android font ascent/descent cannot offset it.
    expect(styleBlock(composeSource, 'fab')).toContain('width: 48');
    expect(styleBlock(composeSource, 'fab')).toContain('height: 48');
    expect(styleBlock(composeSource, 'fabGlyph')).toContain('width: FAB_GLYPH_SIZE');
    expect(styleBlock(composeSource, 'fabGlyph')).toContain('height: FAB_GLYPH_SIZE');
    expect(composeSource).toContain('const FAB_GLYPH_SIZE = 24');
    expect(composeSource).toContain('d="M12 4v16M4 12h16"');
    expect(composeSource).not.toContain('<Text style={styles.fabGlyph}>');
    expect(source).toContain('const COMPOSE_FAB_CLEARANCE = 80');
  });

  it('uses one required unread fact for NEW and the needs-you mark', () => {
    // A cached pre-read-mark response is rejected and fetched again; after
    // that, every visual consequence reads the same server-owned boolean.
    expect(roomViewSource).toContain('readonly unread: boolean;');
    expect(surfaceGuardSource).toContain("typeof item.unread === 'boolean'");
    expect(surfaceGuardSource).not.toContain('item.unread === undefined');
    expect(source).toContain('const unread = item.unread;');
    expect(source).toContain('<HullDeckMark state={deckState} />');
    expect(source).toContain('unread ? (');
    expect(source).toContain('unread && styles.rowUnread');
  });

  it('inherits the deck circle state from the server rollup, not unread alone', () => {
    // Regression: a prior rebuild (#566) collapsed the circle to
    // `unread ? 'needs-you' : 'idle'`, which could never show a live agent
    // turn or a corner needing a human. The precedence decision lives in one
    // pure, tested function — the screen only calls it.
    expect(source).toContain("import { roomDeckState } from '@/buzz/room-deck-state';");
    expect(source).toContain('const deckState = roomDeckState(item);');
    expect(source).not.toContain("unread ? 'needs-you' : 'idle'");
  });

  it('names the corner count "corner(s)", never "changes", and hides it at zero', () => {
    // Regression: the row used to print `${item.cornerCount} changes` verbatim,
    // showing "0 changes" for a Room whose corners had all landed/closed —
    // confusing wording (the product noun is "corner") for a count nothing
    // could act on. The server count already excludes terminal corners; the
    // row must additionally omit the segment entirely rather than show "0".
    expect(source).toContain("import { formatRoomCornerCount } from '@/buzz/vocabulary';");
    expect(source).toContain('const cornerCount = formatRoomCornerCount(item.cornerCount);');
    expect(source).not.toMatch(/\{item\.cornerCount\}\s*changes/);
    expect(source).not.toContain('changes</Text>');
    expect(source).toContain("cornerCount ? ` · ${cornerCount}` : ''");
  });

  it('gives every Room with live corners an inline expansion and navigation affordance', () => {
    expect(source).toContain('item.cornerCount > 0 && (');
    expect(source).toContain('accessibilityState={{ expanded }}');
    expect(source).toContain('testID={`room-corners-toggle-${item.room.id}`}');
    expect(source).toContain('testID={`room-corners-${item.room.id}`}');
    expect(source).toContain('testID={`room-corner-${corner.corner.id}`}');
    expect(source).toContain("'room-list',");
    expect(source).toContain('<Text style={styles.cornerStatus}>{status}</Text>');
  });
});
