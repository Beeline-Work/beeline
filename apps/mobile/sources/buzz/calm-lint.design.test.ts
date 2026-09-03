import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CALM_FONT_SIZES,
  CALM_LETTER_SPACINGS,
  countByFile,
  judgeCalm,
  scanCalmSource,
  scanCalmTree,
  type CalmBaseline,
} from './calm-lint';

/**
 * Borrowing Calm, the lint (DESIGN.md → Type). Every `sources/**\/*.tsx`
 * screen or component is held to its baseline count of raw `fontSize:` /
 * `letterSpacing:` literals outside the type roles. A count may only shrink.
 *
 * Regenerate the baseline after a surface PR removes raw values:
 *   CALM_BASELINE_WRITE=1 npx vitest run sources/buzz/calm-lint
 */
const sourcesDir = fileURLToPath(new URL('..', import.meta.url));
const baselineUrl = new URL('../../design/calm-baseline.json', import.meta.url);

const readBaseline = (): CalmBaseline => JSON.parse(readFileSync(baselineUrl, 'utf8'));

describe('Borrowing Calm lint', () => {
  it('admits only the role sizes and trackings', () => {
    expect([...CALM_FONT_SIZES].sort((a, b) => a - b)).toEqual([10, 13, 16, 22]);
    expect([...CALM_LETTER_SPACINGS].sort((a, b) => a - b)).toEqual([-0.3, 0, 2]);
  });

  it('flags raw literals and passes role values', () => {
    const source = [
      'const s = StyleSheet.create({',
      '  a: { fontSize: 11 },',
      '  b: { fontSize: 16, letterSpacing: 0.8 },',
      '  c: { fontSize: 13, letterSpacing: 2 },',
      "  d: { fontSize: theme.buzz.type.body.fontSize, fontSize: Platform.OS === 'web' ? 17 : 16 },",
      '});',
    ].join('\n');
    expect(scanCalmSource(source, 'x.tsx')).toEqual([
      { file: 'x.tsx', line: 2, text: 'a: { fontSize: 11 },' },
      { file: 'x.tsx', line: 3, text: 'b: { fontSize: 16, letterSpacing: 0.8 },' },
    ]);
  });

  it('holds every screen to its baseline, and the baseline to the scan', () => {
    const offences = scanCalmTree(sourcesDir);
    if (process.env.CALM_BASELINE_WRITE) {
      writeFileSync(baselineUrl, `${JSON.stringify(countByFile(offences), null, 2)}\n`);
    }
    const verdict = judgeCalm(offences, readBaseline());

    const grown = verdict.grown
      .map(
        ({ file, baseline, found, lines }) =>
          `${file}: ${found} raw fontSize/letterSpacing values, baseline ${baseline}\n` +
          lines.map((l) => `  ${file}:${l.line}  ${l.text}`).join('\n'),
      )
      .join('\n');
    expect(
      verdict.grown,
      `New raw fontSize/letterSpacing outside the type roles (theme.buzz.type):\n${grown}`,
    ).toEqual([]);

    const stale = verdict.stale
      .map(({ file, baseline, found }) => `  ${file}: baseline ${baseline}, scan ${found}`)
      .join('\n');
    expect(
      verdict.stale,
      `design/calm-baseline.json lists more than the scan finds; regenerate it with CALM_BASELINE_WRITE=1:\n${stale}`,
    ).toEqual([]);
  });
});
