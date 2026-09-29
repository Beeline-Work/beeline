import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CALM_DECORATIVE_ALLOWLIST,
  CALM_FONT_SIZES,
  CALM_LETTER_SPACINGS,
  CALM_LINE_HEIGHTS,
  CALM_PENDING_HEADER_UNIFY,
  countByFile,
  judgeCalm,
  scanCalmSource,
  scanCalmTree,
  type CalmBaseline,
} from './calm-lint';

/**
 * Borrowing Calm, the lint (DESIGN.md → Type). Every `sources/**\/*.tsx`
 * screen or component — including a raw value fed through a local per-file
 * constant table — is held to its baseline count of raw `fontSize:` /
 * `lineHeight:` / `letterSpacing:` literals outside the type roles. A count
 * may only shrink, and every file outside `CALM_DECORATIVE_ALLOWLIST` /
 * `CALM_PENDING_HEADER_UNIFY` must already be at zero.
 *
 * Regenerate the baseline after a surface PR removes raw values:
 *   CALM_BASELINE_WRITE=1 npx vitest run sources/buzz/calm-lint
 */
const sourcesDir = fileURLToPath(new URL('..', import.meta.url));
const baselineUrl = new URL('../../design/calm-baseline.json', import.meta.url);

const readBaseline = (): CalmBaseline => JSON.parse(readFileSync(baselineUrl, 'utf8'));

describe('Borrowing Calm lint', () => {
  it('admits only the role sizes, line heights and trackings', () => {
    expect([...CALM_FONT_SIZES].sort((a, b) => a - b)).toEqual([10, 13, 16, 22]);
    expect([...CALM_LINE_HEIGHTS].sort((a, b) => a - b)).toEqual([15, 19, 23, 32]);
    expect([...CALM_LETTER_SPACINGS].sort((a, b) => a - b)).toEqual([-0.3, 0, 2]);
  });

  it('flags raw literals (including a local constant table) and passes role values', () => {
    const source = [
      'const LOCAL_TYPE = { fontSize: 11, lineHeight: 17 };',
      'const s = StyleSheet.create({',
      '  a: { fontSize: 11 },',
      '  b: { fontSize: 16, letterSpacing: 0.8 },',
      '  c: { fontSize: 13, letterSpacing: 2, lineHeight: 19 },',
      '  e: { lineHeight: 21 },',
      "  d: { fontSize: theme.buzz.type.body.fontSize, fontSize: Platform.OS === 'web' ? 17 : 16 },",
      '});',
    ].join('\n');
    const localTypeLine = 'const LOCAL_TYPE = { fontSize: 11, lineHeight: 17 };';
    expect(scanCalmSource(source, 'x.tsx')).toEqual([
      { file: 'x.tsx', line: 1, text: localTypeLine },
      { file: 'x.tsx', line: 1, text: localTypeLine },
      { file: 'x.tsx', line: 3, text: 'a: { fontSize: 11 },' },
      { file: 'x.tsx', line: 4, text: 'b: { fontSize: 16, letterSpacing: 0.8 },' },
      { file: 'x.tsx', line: 6, text: 'e: { lineHeight: 21 },' },
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
          `${file}: ${found} raw fontSize/lineHeight/letterSpacing values, baseline ${baseline}\n` +
          lines.map((l) => `  ${file}:${l.line}  ${l.text}`).join('\n'),
      )
      .join('\n');
    expect(
      verdict.grown,
      `New raw fontSize/lineHeight/letterSpacing outside the type roles (theme.buzz.type):\n${grown}`,
    ).toEqual([]);

    const stale = verdict.stale
      .map(({ file, baseline, found }) => `  ${file}: baseline ${baseline}, scan ${found}`)
      .join('\n');
    expect(
      verdict.stale,
      `design/calm-baseline.json lists more than the scan finds; regenerate it with CALM_BASELINE_WRITE=1:\n${stale}`,
    ).toEqual([]);

    const unlisted = verdict.unlisted
      .map(({ file, baseline }) => `  ${file}: baseline ${baseline}`)
      .join('\n');
    expect(
      verdict.unlisted,
      `Every non-decorative, non-pending-header-PR file must be at zero raw literals. Either fix these, or ` +
        `add a commented entry to CALM_DECORATIVE_ALLOWLIST in calm-lint.ts naming the design decision:\n${unlisted}`,
    ).toEqual([]);
  });

  it('names a design decision for every decorative/pending allowlist entry', () => {
    for (const [file, reason] of Object.entries(CALM_DECORATIVE_ALLOWLIST)) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(10);
    }
    for (const [file, reason] of Object.entries(CALM_PENDING_HEADER_UNIFY)) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(10);
    }
  });
});
