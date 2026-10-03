import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

const COLOUR_LITERAL =
  /(['"`])#[0-9A-Fa-f]{3,8}\1|\b(?:rgba?|hsla?)\(|\b(?:color|[a-z]+Color|fill|stroke)\s*[:=]\s*\{?\s*['"](?:white|black|red|green|blue|gray|grey)['"]/g;
const SPACING_LITERAL =
  /\b(?:padding|margin)(?:Top|Bottom|Left|Right|Horizontal|Vertical|Start|End)?:\s*(-?\d+(?:\.\d+)?)\b|\b(?:gap|rowGap|columnGap):\s*(-?\d+(?:\.\d+)?)\b/g;
/** A scale step nudged by a number (`space.sm + 2`): off the scale by construction. */
const NUDGED_SPACING = /\bspace\.(?:xs|sm|md|lg|xl|xxl)\s*[-+]\s*\d/g;
const RADIUS_LITERAL = /\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius:\s*(\d+(?:\.\d+)?)\b/g;
const SHADOW = /\b(?:shadowOpacity|shadowRadius|shadowOffset|boxShadow|textShadow\w*):/g;
const RETIRED_FONT = /IBMPlexSans|BricolageGrotesque|SpaceGrotesk-Bold\b/g;
/** Components DESIGN.md retired in favour of Button and PageHeader. */
const RETIRED_COMPONENT =
  /\b(?:MonoButton|BrassButton|OnboardingButton|RoundButton|MobileGlass)\b|components\/navigation\/Header\b/g;

export type DesignOffence = { rule: DesignRule; file: string; line: number; text: string };

export function scanDesignSource(source: string, file: string): DesignOffence[] {
  const offences: DesignOffence[] = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    // Comments describe rules; they set nothing.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const push = (rule: DesignRule) => offences.push({ rule, file, line: index + 1, text: trimmed });
    for (const _ of text.matchAll(COLOUR_LITERAL)) push('colour');
    for (const match of text.matchAll(SPACING_LITERAL)) {
      const value = Math.abs(Number(match[1] ?? match[2]));
      if (!DESIGN_SPACING.has(value)) push('spacing');
    }
    for (const _ of text.matchAll(NUDGED_SPACING)) push('spacing');
    for (const match of text.matchAll(RADIUS_LITERAL)) {
      const value = Number(match[1]);
      if (!DESIGN_RADII.has(value) && value < 999) push('radius');
    }
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

export function scanDesignTree(sourcesDir: string): DesignOffence[] {
  return walk(sourcesDir, sourcesDir, [])
    .sort()
    .flatMap((path) =>
      scanDesignSource(readFileSync(path, 'utf8'), relative(sourcesDir, path).split(sep).join('/')),
    );
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
