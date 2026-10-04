import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
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
    'components/buzz/AppStatusIndicator.tsx':
      'The connecting app spinner glows amber while it turns: a live signal, not elevation.',
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
    'components/Item.tsx':
      'The iOS row divider starts under the title: side padding plus the 24-point icon slot and its gap (64), or the side padding alone.',
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
/** iOS/web shadows; Android elevation is checked as a complete value below. */
const SHADOW = /\b(?:shadowOpacity|shadowRadius|shadowOffset|boxShadow|textShadow\w*):/g;
const ELEVATION_PROPERTY = /\belevation:\s*/g;
const ZERO_ELEVATION = /^[-+]?0(?:\.0+)?$/;
const RETIRED_FONT = /IBMPlexSans|BricolageGrotesque|SpaceGrotesk-Bold\b/g;
/** Components DESIGN.md retired in favour of Button and PageHeader. */
const RETIRED_COMPONENT =
  /\b(?:MonoButton|BrassButton|OnboardingButton|RoundButton|MobileGlass)\b|components\/navigation\/Header\b/g;

export type DesignOffence = { rule: DesignRule; file: string; line: number; text: string };

/**
 * What a style value can be. A `number` was traced to literals (through local
 * constants, local tables, imported constants, parentheses, arithmetic and
 * `Math.*`). A `token` is read from the theme. `unknown` is a runtime value
 * (safe-area insets, measured sizes, props) that no scale governs. `terms` are
 * the numbers added to a token or runtime value (`space.sm + 2` → [2]). A
 * value with branches (a ternary, `??`, `Math.max(insets.top, 12)`) traces to
 * one entry per branch, and every entry must fit.
 */
type Traced =
  | { kind: 'number'; value: number; half?: boolean }
  | { kind: 'token'; terms: number[] }
  | { kind: 'unknown'; terms: number[] }
  | { kind: 'circle' };

/** The names a module declares and imports, so a value can be traced to its literal. */
export type DesignScope = {
  file: string;
  consts: Map<string, string>;
  exported: Set<string>;
  tables: Map<string, string>;
  rooted: Set<string>;
  /** Local name → the module (sources-relative path) and the name it exports. */
  imports: Map<string, { file: string; name: string }>;
};

/** Every scanned module's scope, by sources-relative path, so an import resolves to its module. */
export type DesignModules = Map<string, DesignScope>;

const NUMBER = /^\d+(?:\.\d+)?$/;
const UNKNOWN: Traced = { kind: 'unknown', terms: [] };
/** A value with more branches than this is not expanded further. */
const MAX_BRANCHES = 64;

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

/** `cond ? a : b` at the top level, split into its three parts (nested ternaries stay in `b`). */
function ternaryParts(text: string): [string, string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  let question = -1;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && ch === '?') {
      // `?.` and `??` are not a ternary.
      if (text[i + 1] === '.' || text[i + 1] === '?') {
        i += 1;
        continue;
      }
      if (question === -1) question = i;
      open++;
    } else if (depth === 0 && ch === ':' && question !== -1) {
      open--;
      if (open === 0) return [text.slice(0, question), text.slice(question + 1, i), text.slice(i + 1)];
    }
  }
  return null;
}

/** Whether `text` is one parenthesised group, `( … )`, end to end. */
function wrappedInParens(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0 && i < text.length - 1) return false;
  }
  return true;
}

const CONTINUES_AFTER = /[-+*/?:=(,|&]\s*$/;
const CONTINUES_BEFORE = /^\s*(?:[-+*/?:|&.]|\?\?)/;

/**
 * The value expression starting at `from`, up to the property's or
 * declaration's end: a top-level `,` or `;`, an unmatched closing bracket, or
 * a line break the expression does not continue across.
 */
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
    else if (ch === '\n' && depth === 0) {
      const sofar = text.slice(from, i);
      if (sofar.trim() && !CONTINUES_AFTER.test(sofar) && !CONTINUES_BEFORE.test(text.slice(i + 1))) {
        return sofar;
      }
    }
  }
  return text.slice(from);
}

function tableProperty(table: string, prop: string): string | null {
  const match = new RegExp(`(?:^|[{,\\s])${prop}\\s*:\\s*`).exec(table);
  return match ? valueAt(table, match.index + match[0].length).trim() : null;
}

/** `source` with its comments blanked to spaces, so offsets and line numbers still match. */
function withoutComments(source: string): string {
  const out = source.split('');
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = ' ';
    } else if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? source.length : close + 2;
      for (; i < stop; i++) if (source[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

function resolveModule(from: string, specifier: string, known: (file: string) => boolean): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = specifier.slice(2);
  else if (specifier.startsWith('.')) base = posix.join(posix.dirname(from), specifier);
  else return null;
  for (const extension of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (known(base + extension)) return base + extension;
  }
  return null;
}

const IMPORT = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

export function designScope(
  source: string,
  file = '',
  known: (file: string) => boolean = () => false,
): DesignScope {
  const code = withoutComments(source);
  const { rooted, objectLiterals } = resolveThemeRootedNames(code);
  const consts = new Map<string, string>();
  for (const match of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)\s*/g)) {
    const expr = valueAt(code, match.index! + match[0].length).trim();
    if (expr && !consts.has(match[1]!)) consts.set(match[1]!, expr);
  }
  const exported = new Set([...code.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));
  const imports = new Map<string, { file: string; name: string }>();
  for (const match of code.matchAll(IMPORT)) {
    const target = resolveModule(file, match[2]!, known);
    if (!target) continue;
    for (const entry of match[1]!.split(',')) {
      const named = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(entry);
      if (named) imports.set(named[2] ?? named[1]!, { file: target, name: named[1]! });
    }
  }
  rooted.add('space');
  return { file, consts, exported, tables: objectLiterals, rooted, imports };
}

/** Every combination of one entry from each list, capped at MAX_BRANCHES. */
function combinations(lists: Traced[][]): Traced[][] {
  let out: Traced[][] = [[]];
  for (const list of lists) {
    out = out.flatMap((prefix) => list.map((item) => [...prefix, item])).slice(0, MAX_BRANCHES);
  }
  return out;
}

function addTerms(traced: Traced[], signs: number[]): Traced {
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

function multiply(traced: Traced[], ops: string[]): Traced {
  const last = traced[traced.length - 1]!;
  // Half of a size: as a radius it draws a round shape (`DOT / 2`, `14 / 2`).
  const half = ops[ops.length - 1] === '/' && last.kind === 'number' && last.value === 2;
  if (traced.every((t) => t.kind === 'number')) {
    let value = (traced[0] as { value: number }).value;
    ops.forEach((op, i) => {
      const next = (traced[i + 1] as { value: number }).value;
      value = op === '*' ? value * next : value / next;
    });
    return { kind: 'number', value, half };
  }
  return half ? { kind: 'circle' } : UNKNOWN;
}

function trace(expr: string, scope: DesignScope, modules: DesignModules, depth = 0): Traced[] {
  let text = expr
    .trim()
    .replace(/\s+as\s+const$/, '')
    .replace(/\s+as\s+\w+$/, '')
    .trim();
  while (wrappedInParens(text)) text = text.slice(1, -1).trim();
  if (!text || depth > 12) return [UNKNOWN];
  const again = (part: string, inScope = scope) => trace(part, inScope, modules, depth + 1);

  const ternary = ternaryParts(text);
  if (ternary) return [...again(ternary[1]), ...again(ternary[2])].slice(0, MAX_BRANCHES);

  const fallback = splitTopLevel(text, /^(?:\?\?|\|\|)/);
  if (fallback.parts.length > 1) return fallback.parts.flatMap((part) => again(part)).slice(0, MAX_BRANCHES);

  const sum = splitTopLevel(text, /^[+-](?![+-=])/);
  // A leading unary minus leaves an empty first part.
  const leading = sum.parts[0]!.trim() === '' ? sum.ops.shift() : undefined;
  if (leading !== undefined) sum.parts.shift();
  if (sum.parts.length > 1 || leading !== undefined) {
    const signs = [leading === '-' ? -1 : 1, ...sum.ops.map((op) => (op === '-' ? -1 : 1))];
    return combinations(sum.parts.map((part) => again(part))).map((combo) => addTerms(combo, signs));
  }

  const product = splitTopLevel(text, /^[*/]/);
  if (product.parts.length > 1) {
    return combinations(product.parts.map((part) => again(part))).map((combo) => multiply(combo, product.ops));
  }

  if (NUMBER.test(text)) return [{ kind: 'number', value: Number(text) }];

  const math = /^Math\.(round|floor|ceil|max|min|abs)\(([\s\S]*)\)$/.exec(text);
  if (math) {
    const args = splitTopLevel(math[2]!, /^,/).parts.map((arg) => again(arg));
    const fn = Math[math[1] as 'max'] as (...values: number[]) => number;
    return combinations(args).map((combo): Traced => {
      if (combo.every((t) => t.kind === 'number')) {
        return { kind: 'number', value: fn(...combo.map((t) => (t as { value: number }).value)) };
      }
      return UNKNOWN;
    }).concat(
      // A runtime argument hides the result, but a number beside it can be the
      // result (`Math.max(insets.top, 12)` is 12 whenever the inset is smaller).
      args.flat().filter((t) => t.kind === 'number'),
    ).slice(0, MAX_BRANCHES);
  }

  const chain = /^([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*)*)$/.exec(text);
  if (!chain) return [UNKNOWN];
  const root = chain[1]!;
  const path = chain[2]!.split(/\??\./).filter(Boolean);
  const step = path[path.length - 1];
  if (step && step in space && (root === 'space' || path.includes('space'))) {
    return [{ kind: 'number', value: space[step as keyof typeof space] }];
  }
  if (path.length === 1 && scope.tables.has(root)) {
    const value = tableProperty(scope.tables.get(root)!, path[0]!);
    return value ? again(value) : [UNKNOWN];
  }
  const init = scope.consts.get(root);
  if (init !== undefined && !init.startsWith('{')) {
    // A local constant: trace what it holds, then any property path read from it.
    if (path.length === 0) return again(init);
    if (/^[A-Za-z_$][\w$.?]*$/.test(init)) return again(`${init}.${path.join('.')}`);
  }
  if (scope.rooted.has(root)) return [{ kind: 'token', terms: [] }];
  const imported = scope.imports.get(root);
  const source = imported ? modules.get(imported.file) : undefined;
  if (imported && source && source.exported.has(imported.name)) {
    const value = source.consts.get(imported.name);
    if (value !== undefined && path.length === 0) return again(value, source);
    if (value !== undefined && /^[A-Za-z_$][\w$.?]*$/.test(value)) {
      return again(`${value}.${path.join('.')}`, source);
    }
  }
  return [UNKNOWN];
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

export function scanDesignSource(
  source: string,
  file: string,
  modules: DesignModules = new Map(),
): DesignOffence[] {
  const offences: DesignOffence[] = [];
  const scope = modules.get(file) ?? designScope(source, file, (name) => modules.has(name));
  // Comments describe rules; they set nothing.
  const code = withoutComments(source);
  const originalLines = source.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
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
  const push = (rule: DesignRule, index: number) => {
    const line = lineAt(index);
    offences.push({ rule, file, line: line + 1, text: originalLines[line]!.trim() });
  };
  const offScale = (pattern: RegExp, rule: DesignRule, fits: (traced: Traced) => boolean) => {
    for (const match of code.matchAll(pattern)) {
      const value = valueAt(code, match.index! + match[0].length);
      if (!trace(value, scope, modules).every(fits)) push(rule, match.index!);
    }
  };
  for (const match of code.matchAll(COLOUR_LITERAL)) push('colour', match.index!);
  offScale(SPACING_PROPERTY, 'spacing', onSpacingScale);
  offScale(RADIUS_PROPERTY, 'radius', onRadiusSet);
  for (const match of code.matchAll(SHADOW)) push('shadow', match.index!);
  for (const match of code.matchAll(ELEVATION_PROPERTY)) {
    const value = valueAt(code, match.index! + match[0].length).trim();
    if (!ZERO_ELEVATION.test(value)) push('shadow', match.index!);
  }
  for (const match of code.matchAll(RETIRED_FONT)) push('font', match.index!);
  for (const match of code.matchAll(RETIRED_COMPONENT)) push('component', match.index!);
  return offences
    .filter((offence) => !(offence.file in DESIGN_ALLOWLIST[offence.rule]))
    .sort((a, b) => a.line - b.line);
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

/** Every module's scope, so an imported constant is traced in the module that exports it. */
export function designModules(files: { source: string; file: string }[]): DesignModules {
  const names = new Set(files.map(({ file }) => file));
  return new Map(
    files.map(({ source, file }) => [file, designScope(source, file, (name) => names.has(name))]),
  );
}

export function scanDesignTree(sourcesDir: string): DesignOffence[] {
  const files = walk(sourcesDir, sourcesDir, [])
    .sort()
    .map((path) => ({
      source: readFileSync(path, 'utf8'),
      file: relative(sourcesDir, path).split(sep).join('/'),
    }));
  const modules = designModules(files);
  return files.flatMap(({ source, file }) => scanDesignSource(source, file, modules));
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
