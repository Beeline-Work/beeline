import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const composeSource = readFileSync(
  new URL('../../../components/buzz/RoomDeckComposeMenu.tsx', import.meta.url),
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
  });
});
