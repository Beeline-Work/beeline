import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { typeRoles } from './groknight';

/**
 * Borrowing Calm lint: the raw `fontSize:`, `lineHeight:` and
 * `letterSpacing:` literals a screen may still set — including one fed from a
 * local per-file constant table (`const X = { fontSize: 14, ... }`), which
 * this regex-per-line scan catches the same as an inline literal since it
 * only cares whether a raw number follows the property name. Only the role
 * values pass; everything else is an offence counted against
 * `apps/mobile/design/calm-baseline.json`.
 */
export const CALM_FONT_SIZES: ReadonlySet<number> = new Set(
  Object.values(typeRoles).map((role) => role.fontSize),
);
export const CALM_LINE_HEIGHTS: ReadonlySet<number> = new Set(
  Object.values(typeRoles).map((role) => role.lineHeight),
);
export const CALM_LETTER_SPACINGS: ReadonlySet<number> = new Set(
  Object.values(typeRoles).map((role) => role.letterSpacing),
);

/**
 * Files carrying an approved, explicitly non-role raw size — never a lapse to
 * quietly shrink. Each entry names the one design decision that licenses it,
 * so a future raw literal added to the SAME file for an unrelated reason is
 * still caught (the baseline count is pinned exactly to what these decisions
 * cover, in `apps/mobile/design/calm-baseline.json`, and `judgeCalm` already
 * refuses a count that GROWS).
 */
export const CALM_DECORATIVE_ALLOWLIST: Readonly<Record<string, string>> = {
  'components/buzz/ConversationComposer.tsx':
    'The Android/web composer input’s lineHeight is pinned BELOW Space Grotesk’s real glyph bounds on purpose (`chat.composer-layout.test.ts`), so native font padding centers text without cropping descenders — the body role’s calmer lineHeight sits above that bound and fails the invariant.',
  'components/buzz/WelcomeCards.tsx':
    'The approved onboarding Welcome Cards art (captain-approved fixed mock, its own bespoke Editorial Ink canvas — never the Obsidian theme) — WELCOME_TYPE is that mock’s own type scale, not a bypass of the app’s shared roles.',
  'app/(app)/beeline/onboarding.tsx':
    'The `beeline.` sign-in wordmark: a brand surface at its own size (28/32), not a reading-text role.',
  'components/buzz/YouStep.tsx':
    'The onboarding identity line’s approved size, `hero.fontSize + body.fontSize` (DESIGN.md, captain-approved) — a deliberate combination of two roles, so its lineHeight is not literally one of the four role values.',
};

/**
 * Files with raw literals still owned by the concurrent `fm/beeline-page-header-unify`
 * PR (screen header blocks and Workbench app pages, per that PR's brief) — not
 * decorative, just not this PR's to touch. Remove an entry here, and its
 * baseline row, once that PR lands and this PR rebases onto it.
 */
export const CALM_PENDING_HEADER_UNIFY: Readonly<Record<string, string>> = {
  'app/(app)/beeline/settings/workbench/app.tsx': 'Workbench app page header, owned by fm/beeline-page-header-unify.',
  'components/navigation/Header.tsx':
    'The ad-hoc back-chevron + title Stack header renderer, owned by fm/beeline-page-header-unify.',
};

const FONT_SIZE = /\bfontSize:\s*(-?\d+(?:\.\d+)?)\b/g;
const LINE_HEIGHT = /\blineHeight:\s*(-?\d+(?:\.\d+)?)\b/g;
const LETTER_SPACING = /\bletterSpacing:\s*(-?\d+(?:\.\d+)?)\b/g;

export type CalmOffence = { file: string; line: number; text: string };

export function scanCalmSource(source: string, file: string): CalmOffence[] {
  const offences: CalmOffence[] = [];
  source.split('\n').forEach((text, index) => {
    for (const [pattern, allowed] of [
      [FONT_SIZE, CALM_FONT_SIZES],
      [LINE_HEIGHT, CALM_LINE_HEIGHTS],
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
  /**
   * A baseline row for a file that is neither an explicit decorative
   * exception nor a currently-excused pending-PR file: the zero-tolerance
   * floor (DESIGN.md → Type) admits no other reason to carry raw literals.
   */
  unlisted: { file: string; baseline: number }[];
};

export function judgeCalm(offences: CalmOffence[], baseline: CalmBaseline): CalmVerdict {
  const found = countByFile(offences);
  const files = new Set([...Object.keys(found), ...Object.keys(baseline)]);
  const verdict: CalmVerdict = { grown: [], stale: [], unlisted: [] };
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
    if (
      expected > 0 &&
      !(file in CALM_DECORATIVE_ALLOWLIST) &&
      !(file in CALM_PENDING_HEADER_UNIFY)
    ) {
      verdict.unlisted.push({ file, baseline: expected });
    }
  }
  return verdict;
}
