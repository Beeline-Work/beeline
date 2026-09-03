import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { typeRoles } from './groknight';

/**
 * Borrowing Calm lint: the raw `fontSize:` and `letterSpacing:` literals a
 * screen may still set. Only the role values pass; everything else is an
 * offence counted against `apps/mobile/design/calm-baseline.json`.
 */
export const CALM_FONT_SIZES: ReadonlySet<number> = new Set(
  Object.values(typeRoles).map((role) => role.fontSize),
);
export const CALM_LETTER_SPACINGS: ReadonlySet<number> = new Set(
  Object.values(typeRoles).map((role) => role.letterSpacing),
);

const FONT_SIZE = /\bfontSize:\s*(-?\d+(?:\.\d+)?)\b/g;
const LETTER_SPACING = /\bletterSpacing:\s*(-?\d+(?:\.\d+)?)\b/g;

export type CalmOffence = { file: string; line: number; text: string };

export function scanCalmSource(source: string, file: string): CalmOffence[] {
  const offences: CalmOffence[] = [];
  source.split('\n').forEach((text, index) => {
    for (const [pattern, allowed] of [
      [FONT_SIZE, CALM_FONT_SIZES],
      [LETTER_SPACING, CALM_LETTER_SPACINGS],
    ] as const) {
      for (const match of text.matchAll(pattern)) {
        if (!allowed.has(Number(match[1]))) {
          offences.push({ file, line: index + 1, text: text.trim() });
        }
      }
    }
  });
  return offences;
}

const SCANNED = /\.tsx$/;
const SKIPPED = /\.(test|spec)\.tsx$/;

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SCANNED.test(entry) && !SKIPPED.test(entry)) out.push(path);
  }
  return out;
}

/** Scan every screen/component under `sourcesDir`; keys are posix paths relative to it. */
export function scanCalmTree(sourcesDir: string): CalmOffence[] {
  return walk(sourcesDir, [])
    .sort()
    .flatMap((path) =>
      scanCalmSource(readFileSync(path, 'utf8'), relative(sourcesDir, path).split(sep).join('/')),
    );
}

export type CalmBaseline = Record<string, number>;

export function countByFile(offences: CalmOffence[]): CalmBaseline {
  const counts: CalmBaseline = {};
  for (const offence of offences) counts[offence.file] = (counts[offence.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export type CalmVerdict = {
  /** Files whose raw-value count grew past the baseline, with the offending lines. */
  grown: { file: string; baseline: number; found: number; lines: CalmOffence[] }[];
  /** Files whose baseline is stale (lists more than the scan finds): regenerate it. */
  stale: { file: string; baseline: number; found: number }[];
};

export function judgeCalm(offences: CalmOffence[], baseline: CalmBaseline): CalmVerdict {
  const found = countByFile(offences);
  const files = new Set([...Object.keys(found), ...Object.keys(baseline)]);
  const verdict: CalmVerdict = { grown: [], stale: [] };
  for (const file of [...files].sort()) {
    const expected = baseline[file] ?? 0;
    const actual = found[file] ?? 0;
    if (actual > expected) {
      verdict.grown.push({
        file,
        baseline: expected,
        found: actual,
        lines: offences.filter((offence) => offence.file === file),
      });
    } else if (actual < expected) {
      verdict.stale.push({ file, baseline: expected, found: actual });
    }
  }
  return verdict;
}
