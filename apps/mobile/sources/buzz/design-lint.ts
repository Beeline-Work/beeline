import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveThemeRootedNames } from './calm-lint';
import { space } from './groknight';

/**
 * The design lint (DESIGN.md → Enforcement). Each rule names one convention
 * from DESIGN.md and finds the lines that break it. Every file is held to its
 * per-rule count in `apps/mobile/design/design-baseline.json`; a count may only
 * shrink, so a new violation fails CI's mobile suite.
 */
export type DesignRule = 'colour' | 'spacing' | 'radius' | 'shadow' | 'font' | 'component';

/** The one spacing scale (`theme.buzz.space`), plus zero. */
export const DESIGN_SPACING: ReadonlySet<number> = new Set([0, ...Object.values(space)]);

/**
 * House 3; code inside a card 8; the transcript card family and composer 10;
 * the phone Room-list card 14. A circle is written as `size / 2` (or 999+).
 */
export const DESIGN_RADII: ReadonlySet<number> = new Set([0, 3, 8, 10, 14]);

/** Files exempt from one rule, each with the decision that licenses it. */
export const DESIGN_ALLOWLIST: Readonly<Record<DesignRule, Readonly<Record<string, string>>>> = {
  colour: {
    'buzz/groknight.ts': 'The token source: every theme colour is defined here.',
    'buzz/brand.json': 'The brand mark colour.',
    'buzz/beeline-glyph.ts': 'The Beeline mark paints its own brand colours in both themes.',
    'buzz/faces/animals.tsx': 'Identity faces: per-identity colours are the identity, not chrome.',
    'buzz/faces/face-tile.tsx': 'Identity faces: per-identity colours are the identity, not chrome.',
    'components/buzz/AppMark.tsx': 'Third-party app marks carry their own brand colours.',
    'buzz/tool-brand-marks.ts': 'Workbench tool marks carry their own brand colours.',
    'components/buzz/WalletQr.tsx': 'A QR code must be black on white to scan in either theme.',
    'components/buzz/ArtifactPdfView.tsx': 'The PDF page is paper: it renders white in both themes.',
    'components/buzz/DesktopArtifactPane.tsx': 'The PDF page is paper: it renders white in both themes.',
    'app/_layout.tsx': 'Native splash and root background before the theme has loaded.',
    'components/AnimatedOverlay.tsx': 'The modal scrim is black at an opacity in both themes.',
  },
  spacing: {},
  radius: {},
  shadow: {
    'components/buzz/HullDialog.tsx':
      'HullDialog and HullActionSheet carry the one product-wide floating-surface shadow.',
    'components/buzz/ConversationComposer.tsx':
      'The listening mic glows brass with the voice volume: a live signal, not elevation.',
  },
  font: {},
  component: {},
};

/**
 * Geometry the baseline still holds, each with the reason the value is not a
 * spacing step or a house radius. Every baseline row must be named here, and
 * every name must still have a baseline row, so a new off-scale value cannot
 * hide in a file that already has one.
 */
export const DESIGN_BASELINE_REASONS: Readonly<Partial<Record<DesignRule, Readonly<Record<string, string>>>>> = {
  radius: {
    'components/buzz/TranscriptCard.tsx':
      'The arrival halo rings sit 4, 16 and 24 outside the card, so each ring is concentric only at the card radius plus its offset.',
  },
  spacing: {
    'app/(app)/beeline/channels.tsx':
      'The empty Room list clears the 80-point compose button that floats over it.',
    'app/(app)/beeline/onboarding.tsx':
      'The focused input thickens its border by 1, and the padding gives that 1 back so the text does not move.',
    'components/buzz/CornerOpenedMarker.tsx':
      'Reserves the 36-point Ledger marginalia column the timestamp hangs in (LEDGER_MARGINALIA_WIDTH).',
    'components/buzz/Ledger.tsx':
      'Reserves the 36-point marginalia column the timestamp hangs in, plus space.sm.',
    'components/buzz/NeedsYouCell.tsx':
      'Clears the absolutely placed 44-point dismiss button and its 4-point inset.',
    'components/buzz/TranscriptScrubber.tsx':
      'Centres the 3-point bar under the 6-point handle: half the width difference.',
    'components/buzz/TurnProgressLine.tsx':
      'TURN_LINE_BAR_MARGIN_BOTTOM is derived from the turn line’s exact-pixel row budget (buzz/room-bottom-chrome.ts).',
    'components/buzz/WalletQr.tsx':
      'The QR quiet zone is one module wide by the QR specification, not a layout step.',
    'components/buzz/WorkflowRunLine.tsx':
      'Step copy starts at COPY_X, the column right of the rail circle and its halo.',
    'components/buzz/WritePermissionOutcome.tsx':
      'Reserves the 36-point Ledger marginalia column the timestamp hangs in (LEDGER_MARGINALIA_WIDTH).',
  },
};

const COLOUR_LITERAL =
  /(['"`])#[0-9A-Fa-f]{3,8}\1|\b(?:rgba?|hsla?)\(|\b(?:color|[a-z]+Color|fill|stroke)\s*[:=]\s*\{?\s*['"](?:white|black|red|green|blue|gray|grey)['"]/g;
const SPACING_PROPERTY =
  /\b(?:(?:padding|margin)(?:Top|Bottom|Left|Right|Horizontal|Vertical|Start|End)?|gap|rowGap|columnGap):\s*/g;
const RADIUS_PROPERTY = /\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius:\s*/g;
/** iOS/web shadows and Android `elevation` (any value but 0). */
const SHADOW =
  /\b(?:shadowOpacity|shadowRadius|shadowOffset|boxShadow|textShadow\w*):|\belevation:\s*(?!0\b)[^\s,}]/g;
const RETIRED_FONT = /IBMPlexSans|BricolageGrotesque|SpaceGrotesk-Bold\b/g;
/** Components DESIGN.md retired in favour of Button and PageHeader. */
const RETIRED_COMPONENT =
  /\b(?:MonoButton|BrassButton|OnboardingButton|RoundButton|MobileGlass)\b|components\/navigation\/Header\b/g;

export type DesignOffence = { rule: DesignRule; file: string; line: number; text: string };

/**
 * What a style value is known to be. A `number` was traced to literals (through
 * local constants, local tables, exported constants, parentheses, arithmetic
 * and `Math.*`). A `token` is read from the theme. `unknown` is a runtime value
 * (safe-area insets, measured sizes, props) that no scale governs. `terms` are
 * the numbers added to a token or runtime value (`space.sm + 2` → [2]).
 */
type Traced =
  | { kind: 'number'; value: number; half?: boolean }
  | { kind: 'token'; terms: number[] }
  | { kind: 'unknown'; terms: number[] }
  | { kind: 'circle' };

/** The names a file declares, so a value can be traced to its literal. */
export type DesignScope = {
  consts: Map<string, string>;
  tables: Map<string, string>;
  rooted: Set<string>;
};

/** Constants other modules export (`export const HULL_SHEET_INSET = 16`), by name. */
export type DesignExports = Map<string, { expr: string; scope: DesignScope }>;

const NUMBER = /^\d+(?:\.\d+)?$/;

/** Split `text` at `separators` that sit outside brackets and strings. */
function splitTopLevel(text: string, separators: RegExp): { parts: string[]; ops: string[] } {
  const parts: string[] = [];
  const ops: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0) {
      const match = separators.exec(text.slice(i));
      if (match && match.index === 0) {
        parts.push(text.slice(start, i));
        ops.push(match[0]);
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return { parts, ops };
}

/** The value expression after `prop:` on one line, up to the property's end. */
function valueAt(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return text.slice(from, i);
      depth--;
    } else if ((ch === ',' || ch === ';') && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

function tableProperty(table: string, prop: string): string | null {
  const match = new RegExp(`(?:^|[{,\\s])${prop}\\s*:\\s*`).exec(table);
  return match ? valueAt(table, match.index + match[0].length).trim() : null;
}

export function designScope(source: string): DesignScope {
  const { rooted, objectLiterals } = resolveThemeRootedNames(source);
  const consts = new Map<string, string>();
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g)) {
    const start = match.index! + match[0].length;
    const end = source.indexOf('\n', start);
    const expr = valueAt(source.slice(start, end === -1 ? undefined : end), 0).trim();
    if (expr && !consts.has(match[1]!)) consts.set(match[1]!, expr);
  }
  rooted.add('space');
  return { consts, tables: objectLiterals, rooted };
}

function trace(expr: string, scope: DesignScope, exports: DesignExports, depth = 0): Traced {
  const text = expr
    .trim()
    .replace(/\s+as\s+const$/, '')
    .replace(/\s+as\s+\w+$/, '');
  if (!text || depth > 8) return { kind: 'unknown', terms: [] };

  const sum = splitTopLevel(text, /^[+-](?![+-=])/);
  // A leading unary minus leaves an empty first part.
  const leading = sum.parts[0]!.trim() === '' ? sum.ops.shift() : undefined;
  if (leading !== undefined) sum.parts.shift();
  if (sum.parts.length > 1 || leading !== undefined) {
    const signs = [leading === '-' ? -1 : 1, ...sum.ops.map((op) => (op === '-' ? -1 : 1))];
    const traced = sum.parts.map((part) => trace(part, scope, exports, depth + 1));
    if (traced.every((t) => t.kind === 'number')) {
      return {
        kind: 'number',
        value: traced.reduce((total, t, i) => total + signs[i]! * (t as { value: number }).value, 0),
      };
    }
    const terms: number[] = [];
    let runtime = false;
    for (const [i, t] of traced.entries()) {
      if (t.kind === 'number') terms.push(signs[i]! * t.value);
      else {
        if (t.kind !== 'token') runtime = true;
        if (t.kind !== 'circle') terms.push(...t.terms);
      }
    }
    return runtime ? { kind: 'unknown', terms } : { kind: 'token', terms };
  }

  const product = splitTopLevel(text, /^[*/]/);
  if (product.parts.length > 1) {
    const traced = product.parts.map((part) => trace(part, scope, exports, depth + 1));
    const last = traced[traced.length - 1]!;
    // Half of a size: as a radius it draws a round shape (`DOT / 2`, `14 / 2`).
    const half = product.ops[product.ops.length - 1] === '/' && last.kind === 'number' && last.value === 2;
    if (traced.every((t) => t.kind === 'number')) {
      let value = (traced[0] as { value: number }).value;
      product.ops.forEach((op, i) => {
        const next = (traced[i + 1] as { value: number }).value;
        value = op === '*' ? value * next : value / next;
      });
      return { kind: 'number', value, half };
    }
    if (half) return { kind: 'circle' };
    return { kind: 'unknown', terms: [] };
  }

  if (NUMBER.test(text)) return { kind: 'number', value: Number(text) };
  if (text.startsWith('(') && text.endsWith(')')) return trace(text.slice(1, -1), scope, exports, depth + 1);

  const math = /^Math\.(round|floor|ceil|max|min|abs)\((.*)\)$/.exec(text);
  if (math) {
    const args = splitTopLevel(math[2]!, /^,/).parts.map((arg) => trace(arg, scope, exports, depth + 1));
    if (args.every((t) => t.kind === 'number')) {
      const values = args.map((t) => (t as { value: number }).value);
      return { kind: 'number', value: (Math[math[1] as 'max'] as (...v: number[]) => number)(...values) };
    }
    return { kind: 'unknown', terms: [] };
  }

  const chain = /^([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*)*)$/.exec(text);
  if (!chain) return { kind: 'unknown', terms: [] };
  const root = chain[1]!;
  const path = chain[2]!.split(/\??\./).filter(Boolean);
  const step = path[path.length - 1];
  if (step && step in space && (root === 'space' || path.includes('space'))) {
    return { kind: 'number', value: space[step as keyof typeof space] };
  }
  if (scope.rooted.has(root)) return { kind: 'token', terms: [] };
  if (path.length === 1 && scope.tables.has(root)) {
    const value = tableProperty(scope.tables.get(root)!, path[0]!);
    return value ? trace(value, scope, exports, depth + 1) : { kind: 'unknown', terms: [] };
  }
  if (path.length === 0 && scope.consts.has(root)) {
    return trace(scope.consts.get(root)!, scope, exports, depth + 1);
  }
  const exported = path.length === 0 ? exports.get(root) : undefined;
  if (exported) return trace(exported.expr, exported.scope, exports, depth + 1);
  return { kind: 'unknown', terms: [] };
}

/** Whether a traced spacing value is on the scale (sign aside), and so is every number added to a token. */
function onSpacingScale(traced: Traced): boolean {
  if (traced.kind === 'number') return DESIGN_SPACING.has(Math.abs(traced.value));
  if (traced.kind === 'circle') return true;
  return traced.terms.every((term) => DESIGN_SPACING.has(Math.abs(term)));
}

/** A house radius, a round shape (`size / 2`, 999+), or a token with nothing added. */
function onRadiusSet(traced: Traced): boolean {
  if (traced.kind === 'number') {
    return DESIGN_RADII.has(traced.value) || traced.value >= 999 || traced.half === true;
  }
  if (traced.kind === 'circle') return true;
  return traced.terms.every((term) => term === 0);
}

/** Every branch of a ternary or fallback is checked on its own. */
function branches(expr: string): string[] {
  const ternary = splitTopLevel(expr, /^\?(?![?.])/);
  if (ternary.parts.length > 1) {
    const rest = ternary.parts.slice(1).join('?');
    return splitTopLevel(rest, /^:/).parts.flatMap(branches);
  }
  const fallback = splitTopLevel(expr, /^(?:\?\?|\|\|)/);
  return fallback.parts.length > 1 ? fallback.parts.flatMap(branches) : [expr];
}

export function scanDesignSource(
  source: string,
  file: string,
  exports: DesignExports = new Map(),
): DesignOffence[] {
  const offences: DesignOffence[] = [];
  const scope = designScope(source);
  const offScale = (text: string, pattern: RegExp, fits: (traced: Traced) => boolean) => {
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      const value = valueAt(text, match.index! + match[0].length);
      if (branches(value).some((branch) => !fits(trace(branch, scope, exports)))) count++;
    }
    return count;
  };
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    // Comments describe rules; they set nothing.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const push = (rule: DesignRule) => offences.push({ rule, file, line: index + 1, text: trimmed });
    for (const _ of text.matchAll(COLOUR_LITERAL)) push('colour');
    for (let i = offScale(text, SPACING_PROPERTY, onSpacingScale); i > 0; i--) push('spacing');
    for (let i = offScale(text, RADIUS_PROPERTY, onRadiusSet); i > 0; i--) push('radius');
    for (const _ of text.matchAll(SHADOW)) push('shadow');
    for (const _ of text.matchAll(RETIRED_FONT)) push('font');
    for (const _ of text.matchAll(RETIRED_COMPONENT)) push('component');
  });
  return offences.filter((offence) => !(offence.file in DESIGN_ALLOWLIST[offence.rule]));
}

const SCANNED = /\.(tsx?|json)$/;
const SKIPPED = /\.(test|spec)\.tsx?$|\.d\.ts$|\.gen\.ts$/;
const SKIPPED_DIRS = new Set(['vendor', 'test', 'text']);
/** The lints name the patterns they forbid. */
const SELF = new Set(['buzz/design-lint.ts', 'buzz/calm-lint.ts']);

function walk(root: string, dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) walk(root, path, out);
    } else if (SCANNED.test(entry) && !SKIPPED.test(entry)) {
      const file = relative(root, path).split(sep).join('/');
      if (!SELF.has(file)) out.push(path);
    }
  }
  return out;
}

/** Every exported numeric-looking constant in the tree, so an import is traced too. */
export function designExports(files: { source: string }[]): DesignExports {
  const exports: DesignExports = new Map();
  for (const { source } of files) {
    if (!/\bexport\s+const\b/.test(source)) continue;
    const scope = designScope(source);
    for (const match of source.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\b/g)) {
      const expr = scope.consts.get(match[1]!);
      if (expr && !exports.has(match[1]!)) exports.set(match[1]!, { expr, scope });
    }
  }
  return exports;
}

export function scanDesignTree(sourcesDir: string): DesignOffence[] {
  const files = walk(sourcesDir, sourcesDir, [])
    .sort()
    .map((path) => ({
      source: readFileSync(path, 'utf8'),
      file: relative(sourcesDir, path).split(sep).join('/'),
    }));
  const exports = designExports(files);
  return files.flatMap(({ source, file }) => scanDesignSource(source, file, exports));
}

/** `{ rule: { file: count } }`, sorted for a stable JSON file. */
export type DesignBaseline = Partial<Record<DesignRule, Record<string, number>>>;

export function designCounts(offences: DesignOffence[]): DesignBaseline {
  const counts: Record<string, Record<string, number>> = {};
  for (const { rule, file } of offences) {
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((rule) => [
        rule,
        Object.fromEntries(Object.entries(counts[rule]!).sort(([a], [b]) => (a < b ? -1 : 1))),
      ]),
  );
}

export type DesignVerdict = {
  grown: { rule: DesignRule; file: string; baseline: number; found: number; lines: DesignOffence[] }[];
  stale: { rule: DesignRule; file: string; baseline: number; found: number }[];
};

export function judgeDesign(offences: DesignOffence[], baseline: DesignBaseline): DesignVerdict {
  const found = designCounts(offences);
  const verdict: DesignVerdict = { grown: [], stale: [] };
  const rules = new Set([...Object.keys(found), ...Object.keys(baseline)]) as Set<DesignRule>;
  for (const rule of [...rules].sort()) {
    const now = found[rule] ?? {};
    const was = baseline[rule] ?? {};
    for (const file of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort()) {
      const actual = now[file] ?? 0;
      const expected = was[file] ?? 0;
      if (actual > expected) {
        const lines = offences.filter((o) => o.rule === rule && o.file === file);
        verdict.grown.push({ rule, file, baseline: expected, found: actual, lines });
      } else if (actual < expected) {
        verdict.stale.push({ rule, file, baseline: expected, found: actual });
      }
    }
  }
  return verdict;
}
