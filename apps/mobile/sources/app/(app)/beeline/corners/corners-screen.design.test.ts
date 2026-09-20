import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { beelineThemes, typeRoles, space, layout } from '@/buzz/groknight';

/**
 * The Room's corners screen, held to the index vocabulary DESIGN.md gives
 * every other list in the product — the Members page is the reference
 * implementation of it.
 *
 * Two things this file exists to keep out. The first is the explainer: a
 * heading and a paragraph telling the reader what a corner is, standing over
 * a list of corners. A screen that has to describe its own contents has not
 * been designed yet, and the copy goes stale the moment the model moves. The
 * second is a plate: chrome on this product sits ON the slab, held apart by
 * one hairline and by type weight, and `HullSurface` is reserved for
 * something that genuinely floats over it.
 */
const screenSource = readFileSync(path.join(__dirname, '[roomId].tsx'), 'utf8');
const listSource = readFileSync(
  path.join(__dirname, '../../../../components/buzz/RoomCornersList.tsx'),
  'utf8',
);
const membersSource = readFileSync(path.join(__dirname, '../MembersScreen.tsx'), 'utf8');

/** Every raw `fontSize:` / `letterSpacing:` outside the four type roles. */
function rawTypeLiterals(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => /\b(?:fontSize|letterSpacing):\s*-?\d/.test(line))
    .map((line) => line.trim());
}

function styleBlock(source: string, name: string): string {
  const start = source.indexOf(`    ${name}: {`);
  expect(start, `missing style ${name}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n    },', start));
}

describe('the Room corners screen belongs to the app', () => {
  it('carries no explainer over its own list', () => {
    for (const retired of [
      'YOLO INSIDE',
      'modelPanel',
      'modelTitle',
      'modelText',
      'GITHUB IS THE LIFECYCLE',
    ]) {
      expect(screenSource, `${retired} should stay retired`).not.toContain(retired);
    }
  });

  it('sits its header on the slab, not on a plate', () => {
    expect(screenSource).not.toContain('<HullSurface');
    expect(screenSource).not.toContain('HullSurface,');
    expect(styleBlock(screenSource, 'header')).toContain('borderBottomWidth');
    expect(styleBlock(screenSource, 'header')).not.toContain('backgroundColor');
  });

  it('speaks in the four type roles and the one spacing scale', () => {
    expect(rawTypeLiterals(screenSource)).toEqual([]);
    expect(rawTypeLiterals(listSource)).toEqual([]);
    // The same roles the Members page's header uses, in the same places.
    expect(styleBlock(screenSource, 'title')).toContain('...hull.type.hero');
    expect(styleBlock(screenSource, 'eyebrow')).toContain('...hull.type.meta');
    expect(styleBlock(membersSource, 'title')).toContain('...hull.type.hero');
    expect(styleBlock(screenSource, 'back')).toContain('width: 44');
    expect(styleBlock(screenSource, 'back')).toContain('height: 44');
    expect(screenSource).toContain('accessibilityLabel="Back"');
    // Spacing comes off the scale; nothing is nudged by 3.
    const offScale = [...screenSource.matchAll(/\b(?:padding|margin|gap)\w*:\s*(\d+)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => value !== 0 && !Object.values(space).includes(value as never));
    expect(offScale).toEqual([]);
  });

  it('gives its rows the index height and the state in words', () => {
    expect(styleBlock(listSource, 'row')).toContain('minHeight: hull.layout.row');
    expect(layout.row).toBe(64);
    expect(listSource).toContain('{display.word}');
    expect(listSource).toContain('<StateCircle state={display.visual} tone={display.tone} />');
    // Brass only where the corner wants the viewer; the other tones are the
    // ledger's own quiet and ghost tiers.
    const hull = beelineThemes.obsidian;
    expect(styleBlock(listSource, 'stateBrass')).toContain('color: hull.accent');
    expect(hull.accent).not.toBe(hull.ledgerQuiet);
    expect(typeRoles.sectionHead.textTransform).toBe('uppercase');
    expect(styleBlock(listSource, 'state')).toContain('...hull.type.sectionHead');
  });

  it('runs the list to the bottom edge instead of under the gesture bar', () => {
    expect(screenSource).toContain('bottomInset={insets.bottom}');
    expect(listSource).toContain('paddingBottom: bottomInset');
  });
});
