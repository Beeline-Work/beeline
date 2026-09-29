import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { typeRoles } from './groknight';

/**
 * Borrowing Calm lint: the raw `fontSize:`, `lineHeight:` and
 * `letterSpacing:` literals a screen may still set. Two shapes are caught:
 * a raw digit fed straight to the property, INCLUDING one hiding inside a
 * local per-file constant table (`const X = { fontSize: 14 }` — the digit
 * sits right after the property name regardless of which object holds it);
 * and a reference to a local, non-theme constant whose OWN raw digit lives
 * under a renamed key (`const WELCOME_TYPE = { size36: 36 }`, then
 * `fontSize: WELCOME_TYPE.size36` — no digit is adjacent to `fontSize:` at
 * all, so only tracing the reference back to its declaration catches it;
 * see `resolveThemeRootedNames`). Only the role values, or a reference that
 * traces to `theme`/`typeRoles`, pass; everything else is an offence counted
 * against `apps/mobile/design/calm-baseline.json`.
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
  'components/buzz/TurnProgressLine.tsx':
    'TURN_LABEL_LINE_HEIGHT (`buzz/room-bottom-chrome.ts`) is the captain-authored exact-pixel budget for the turn line’s row (24px row, 18px label ink, equal air above/below — captain 2026-09-22): the label text’s lineHeight must equal that same 18, not the machine role’s 19, or the hand-derived geometry (TURN_LINE_INK_AIR, TURN_LINE_BAR_MARGIN_BOTTOM) drifts off its own stated arithmetic.',
  'components/buzz/WelcomeCards.tsx':
    'The approved onboarding Welcome Cards art (captain-approved fixed mock, its own bespoke Editorial Ink canvas — never the Obsidian theme; the desktop 36/43 title shipped in PR #1891) — WELCOME_TYPE is that mock’s own type scale, not a bypass of the app’s shared roles.',
  'app/(app)/beeline/onboarding.tsx':
    'The `beeline.` sign-in wordmark: a brand surface at its own size (28/32), not a reading-text role.',
  'components/buzz/YouStep.tsx':
    'The onboarding identity line’s approved size, `hero.fontSize + body.fontSize` (DESIGN.md, captain-approved) — a deliberate combination of two roles, so its lineHeight is not literally one of the four role values.',
};

/**
 * Files with raw literals still owned by the concurrent `fm/beeline-page-header-unify`
 * PR (screen header blocks and Workbench app pages, per that PR's brief). That
 * PR merged (#1903) and this branch rebased onto it — empty until a future
 * concurrent PR needs the same temporary carve-out.
 */
export const CALM_PENDING_HEADER_UNIFY: Readonly<Record<string, string>> = {};

const FONT_SIZE = /\bfontSize:\s*(-?\d+(?:\.\d+)?)\b/g;
const LINE_HEIGHT = /\blineHeight:\s*(-?\d+(?:\.\d+)?)\b/g;
const LETTER_SPACING = /\bletterSpacing:\s*(-?\d+(?:\.\d+)?)\b/g;

/**
 * A `fontSize`/`lineHeight`/`letterSpacing` value that is ONLY an identifier
 * chain (`WELCOME_TYPE.size36`, `metric.bodySize`, `theme.buzz.type.body.fontSize`)
 * — matched only when the chain is immediately followed by a terminator
 * (`,` `}` `;` newline), so a ternary (`isDesktop ? 17 : 16`) or arithmetic
 * (`hull.type.body.fontSize - 1`) never matches: those already can't be
 * statically proven either way and are left alone, same as before.
 */
const TYPE_REF = /\b(fontSize|lineHeight|letterSpacing):\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?=[,}\n;])/g;
/** TS primitive-type keywords: `{ fontSize: number }` is a type annotation, not a value. */
const TS_PRIMITIVE_TYPES = new Set([
  'number', 'string', 'boolean', 'any', 'unknown', 'never', 'void', 'undefined', 'null', 'object', 'symbol', 'bigint',
]);

const CONST_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g;

function matchBalancedBraces(source: string, openIndex: number): string | null {
  if (source[openIndex] !== '{') return null;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

/**
 * Every local name a file declares whose value chain traces back to the
 * theme (`const hull = theme.buzz`, `const metric = card.transcriptCard`),
 * PLUS every local `const NAME = { ... }` object literal, keyed to its raw
 * literal body text so a later reference to one specific property
 * (`resolvePropertyRoot`) can be checked on its own — a table mixing a
 * theme-sourced property with unrelated raw geometry numbers (padding,
 * `HULL_DIALOG_LAYOUT`'s `actionButtonMinHeight: 44` beside its
 * `titleLineHeight: typeRoles.bodyStrong.lineHeight`) must not condemn the
 * one property that IS theme-sourced, the way a whole-object check would.
 *
 * `theme` and an imported `typeRoles` are always theme-rooted roots.
 */
export function resolveThemeRootedNames(source: string): {
  rooted: Set<string>;
  objectLiterals: Map<string, string>;
} {
  const rooted = new Set<string>(['theme']);
  if (/\bimport\s*\{[^}]*\btypeRoles\b[^}]*\}\s*from\s*['"][^'"]*groknight['"]/.test(source)) {
    rooted.add('typeRoles');
  }
  const objectLiterals = new Map<string, string>();

  const declarations: { name: string; rhsStart: number }[] = [];
  for (const match of source.matchAll(CONST_DECL)) {
    declarations.push({ name: match[1]!, rhsStart: match.index! + match[0].length });
  }

  for (const { name, rhsStart } of declarations) {
    const rhs = source.slice(rhsStart, rhsStart + 200);
    if (rhs[0] === '{') {
      const literal = matchBalancedBraces(source, rhsStart);
      if (literal && !objectLiterals.has(name)) objectLiterals.set(name, literal);
    }
  }

  // Fixpoint over declaration order: an alias may reference a name declared
  // earlier in the same pass (a direct `theme.buzz` chain, or a bracket
  // lookup into a table every one of whose OWN top-level values is itself
  // theme-rooted, e.g. `{ large: typeRoles.hero, normal: typeRoles.body }` —
  // a dynamic key picks one of those, so the picked value is theme-rooted
  // whichever key it is), so two passes cover the common forward case
  // without a full dependency graph.
  for (let pass = 0; pass < 2; pass++) {
    for (const { name, rhsStart } of declarations) {
      if (rooted.has(name)) continue;
      const rhs = source.slice(rhsStart, rhsStart + 200);
      const chain = /^([A-Za-z_$][\w$]*)/.exec(rhs);
      if (!chain) continue;
      const base = chain[1]!;
      if (rooted.has(base)) {
        rooted.add(name);
        continue;
      }
      const table = objectLiterals.get(base);
      if (table && objectLiteralIsFullyThemeRooted(table, rooted)) rooted.add(name);
    }
  }
  return { rooted, objectLiterals };
}

/** Every top-level property value in `literal` traces to a theme-rooted name. */
function objectLiteralIsFullyThemeRooted(literal: string, rooted: Set<string>): boolean {
  const inner = literal.slice(1, -1);
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      segments.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(inner.slice(start));

  let hasProperty = false;
  for (const segment of segments) {
    const colon = segment.indexOf(':');
    if (colon === -1) continue;
    hasProperty = true;
    const value = segment.slice(colon + 1).trim();
    const valueRoot = /^([A-Za-z_$][\w$]*)/.exec(value)?.[1];
    if (!valueRoot || !rooted.has(valueRoot)) return false;
  }
  return hasProperty;
}

/**
 * Whether `root.prop(...)` is theme-sourced: `root` itself traced to the
 * theme (any depth past that point is trusted, matching prior behavior), or
 * `root` is a local object literal whose OWN `prop` property is itself a
 * theme-rooted reference (`titleLineHeight: typeRoles.bodyStrong.lineHeight`
 * passes; `size16: 16` does not — checked one property at a time, so a
 * sibling raw-number property elsewhere in the same table never matters).
 * Anything else (an imported constant, a computed/indexed lookup, an
 * unresolved property) is NOT theme-sourced: deny by default.
 */
function resolvePropertyRoot(
  root: string,
  prop: string,
  rooted: Set<string>,
  objectLiterals: Map<string, string>,
): boolean {
  if (rooted.has(root)) return true;
  const literal = objectLiterals.get(root);
  if (!literal) return false;
  const propertyValue = new RegExp(`\\b${prop}\\s*:\\s*([^,\\n}]+)`).exec(literal);
  if (!propertyValue) return false;
  const value = propertyValue[1]!.trim();
  const valueRoot = /^([A-Za-z_$][\w$]*)/.exec(value)?.[1];
  return valueRoot != null && rooted.has(valueRoot);
}

export type CalmOffence = { file: string; line: number; text: string };

export function scanCalmSource(source: string, file: string): CalmOffence[] {
  const offences: CalmOffence[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lines = source.split('\n');
  const pushOffence = (index: number) => {
    const lineIndex = lineAt(index);
    offences.push({ file, line: lineIndex + 1, text: lines[lineIndex]!.trim() });
  };

  lines.forEach((text, index) => {
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

  const { rooted, objectLiterals } = resolveThemeRootedNames(source);
  for (const match of source.matchAll(TYPE_REF)) {
    const segments = match[2]!.split('.');
    const root = segments[0]!;
    if (TS_PRIMITIVE_TYPES.has(root)) continue;
    if (root === 'theme' || rooted.has(root)) continue;
    const prop = segments[1];
    if (prop && resolvePropertyRoot(root, prop, rooted, objectLiterals)) continue;
    pushOffence(match.index!);
  }

  return offences.sort((a, b) => a.line - b.line);
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
