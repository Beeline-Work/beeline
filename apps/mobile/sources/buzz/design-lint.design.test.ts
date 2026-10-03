import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_ALLOWLIST,
  DESIGN_RADII,
  DESIGN_SPACING,
  designCounts,
  judgeDesign,
  scanDesignSource,
  scanDesignTree,
  type DesignBaseline,
} from './design-lint';

/**
 * The design lint (DESIGN.md → Enforcement). Every `sources/**` module is held
 * to its per-rule baseline count of colour literals, off-scale spacing,
 * off-scale radii, shadows, retired fonts and retired components. A count may
 * only shrink.
 *
 * Regenerate the baseline after a change removes violations:
 *   DESIGN_BASELINE_WRITE=1 npx vitest run sources/buzz/design-lint
 */
const sourcesDir = fileURLToPath(new URL('..', import.meta.url));
const baselineUrl = new URL('../../design/design-baseline.json', import.meta.url);
const readBaseline = (): DesignBaseline =>
  existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, 'utf8')) : {};

describe('design lint', () => {
  it('admits only the spacing scale and the house radii', () => {
    expect([...DESIGN_SPACING].sort((a, b) => a - b)).toEqual([0, 4, 8, 16, 24, 32, 48]);
    expect([...DESIGN_RADII].sort((a, b) => a - b)).toEqual([0, 3, 8, 10, 14]);
  });

  it('finds each kind of violation and passes the tokens', () => {
    const source = [
      'const s = StyleSheet.create((theme) => ({',
      "  a: { color: '#b08a4a', backgroundColor: 'rgba(0,0,0,0.5)' },",
      "  b: { backgroundColor: 'white' },",
      '  c: { padding: 12, marginTop: 2, gap: 8, paddingHorizontal: theme.buzz.space.md },',
      '  g: { paddingHorizontal: theme.buzz.space.sm + 2 },',
      '  d: { borderRadius: 16, borderTopLeftRadius: 3, borderRadius: SIZE / 2 },',
      '  e: { shadowOpacity: 0.2, shadowRadius: 8 },',
      "  f: { fontFamily: 'IBMPlexSans-Regular', color: theme.buzz.accent },",
      '}));',
      "import { MonoButton } from './MonoHull';",
      "  // A comment may name '#b08a4a' and padding: 12 freely.",
    ].join('\n');
    expect(scanDesignSource(source, 'x.tsx').map(({ rule, line }) => `${rule}@${line}`)).toEqual([
      'colour@2',
      'colour@2',
      'colour@3',
      'spacing@4',
      'spacing@4',
      'spacing@5',
      'radius@6',
      'shadow@7',
      'shadow@7',
      'font@8',
      'component@10',
    ]);
  });

  it('holds every module to its baseline, and the baseline to the scan', () => {
    const offences = scanDesignTree(sourcesDir);
    if (process.env.DESIGN_BASELINE_WRITE) {
      writeFileSync(baselineUrl, `${JSON.stringify(designCounts(offences), null, 2)}\n`);
    }
    const verdict = judgeDesign(offences, readBaseline());
    const grown = verdict.grown
      .map(
        ({ rule, file, baseline, found, lines }) =>
          `${rule} ${file}: ${found}, baseline ${baseline}\n` +
          lines.map((l) => `  ${file}:${l.line}  ${l.text}`).join('\n'),
      )
      .join('\n');
    expect(
      verdict.grown,
      `New design-rule violations (DESIGN.md → Enforcement). Use theme tokens, the spacing ` +
        `scale (theme.buzz.space), the house radii, Button/PageHeader:\n${grown}`,
    ).toEqual([]);
    const stale = verdict.stale
      .map(({ rule, file, baseline, found }) => `  ${rule} ${file}: baseline ${baseline}, scan ${found}`)
      .join('\n');
    expect(
      verdict.stale,
      `design/design-baseline.json lists more than the scan finds; regenerate it with DESIGN_BASELINE_WRITE=1:\n${stale}`,
    ).toEqual([]);
  });

  it('names a reason for every allowlisted file', () => {
    for (const [rule, files] of Object.entries(DESIGN_ALLOWLIST)) {
      for (const [file, reason] of Object.entries(files)) {
        expect(reason.length, `${rule} ${file} needs a real reason`).toBeGreaterThan(10);
      }
    }
  });

  it('keeps the retired fonts and components out of the tree entirely', () => {
    const baseline = readBaseline();
    expect(baseline.font ?? {}).toEqual({});
    expect(baseline.component ?? {}).toEqual({});
    expect(baseline.shadow ?? {}).toEqual({});
  });
});
