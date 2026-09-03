import brand from './brand.json';

/**
 * Beeline's one app-wide visual language, Obsidian Refined. Components consume
 * this one semantic token shape.
 *
 * Content colors are intentionally brighter than chrome colors. `textMuted`
 * and the ledger quiet/ghost tiers are for labels and redundant metadata only,
 * never for narration or human messages.
 */
const shared = {
  brandMark: brand.mark,
  diffAdded: '#3FB950',
  diffRemoved: '#F85149',
  // Human and agent relay photos defeat their identity axes, so their shared
  // photo gate stays off. Workspace pictures are the explicit exception and
  // are gated separately in photo-overrides.ts.
  photoIdentityMarksEnabled: false,
} as const;

/**
 * Borrowing Calm — the type roles (design note 2026-09-03, DESIGN.md → Type).
 *
 * Four sizes, one mono role. A screen sets text through one of these
 * roles, never a raw `fontSize`/`letterSpacing`; `calm-lint.design.test.ts`
 * holds every file to its baseline count of raw values. Line height is 1.45×
 * the size, rounded.
 */
const calmLineHeight = (fontSize: number) => Math.round(fontSize * 1.45);
const sans = {
  regular: 'SpaceGrotesk-Regular',
  medium: 'SpaceGrotesk-Medium',
  semiBold: 'SpaceGrotesk-SemiBold',
} as const;
const mono = 'IBMPlexMono-Regular';

export type TypeRole = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly textTransform?: 'uppercase';
};

export const typeRoles = {
  /** A screen's one big line, including index row names. */
  hero: { fontFamily: sans.medium, fontSize: 22, lineHeight: calmLineHeight(22), letterSpacing: -0.3 },
  /** Body text and row titles. */
  body: { fontFamily: sans.regular, fontSize: 16, lineHeight: calmLineHeight(16), letterSpacing: 0 },
  bodyStrong: { fontFamily: sans.semiBold, fontSize: 16, lineHeight: calmLineHeight(16), letterSpacing: 0 },
  /** Everything secondary: previews, captions, stamps, counts. Sans, never mono. */
  meta: { fontFamily: sans.regular, fontSize: 13, lineHeight: calmLineHeight(13), letterSpacing: 0 },
  /** Section heads ONLY — the one tracked-uppercase style. */
  sectionHead: {
    fontFamily: sans.medium,
    fontSize: 10,
    lineHeight: calmLineHeight(10),
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  /** Literal machine output: commands, paths, hashes, code, tool rows, their timestamps. */
  machine: { fontFamily: mono, fontSize: 13, lineHeight: calmLineHeight(13), letterSpacing: 0 },
} as const satisfies Record<string, TypeRole>;
export type TypeRoleName = keyof typeof typeRoles;

/** The one spacing scale. Nothing is nudged by 3. */
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
export type SpaceStep = keyof typeof space;
/** Rows are 64 tall, sections sit 24 apart, screens start 24 below the header. */
export const layout = { row: 64, sectionGap: 24, screenTop: 24 } as const;

export const beelineThemes = {
  obsidian: {
    ...shared,
    type: typeRoles,
    space,
    layout,
    name: 'obsidian',
    label: 'Obsidian Refined',
    description: 'Readable sans prose on a quiet obsidian field',
    dark: true,
    // Canvas = Speakeasy's brand canvas `#14091A` (apps/mobile/src/theme/
    // tokens.ts), applied at the token level so every screen inherits it.
    // Every elevation stop below keeps the EXACT channel offset its stop had
    // from the old near-black base (#070708), so borders/dividers/text
    // contrast relationships are unchanged — the ladder just rises from the
    // aubergine canvas now.
    bgVoid: '#14091A',
    bgTerminal: '#14091A',
    bgBase: '#14091A',
    bgRaised: '#190e21',
    bgCode: '#190e21',
    bgHighlight: '#1e1326',
    // One luminance step above the canvas: an unread row's whole-ground fill
    // (Gmail-dark-mode pattern — area, never stroke). Deliberately below
    // bgHighlight so selection still reads brighter than freshness.
    bgUnread: '#1a1220',
    bgHover: '#21162a',
    bgPressed: '#271c31',
    bgTexturePeak: '#3b3048',
    bgVisual: '#190e21',
    textPrimary: '#f0f0f3',
    textSecondary: '#c9c9d1',
    textMuted: '#83838d',
    textDisabled: '#6c6c76',
    textInverted: '#111111',
    actionFill: '#f0f0f3',
    chrome: '#83838d',
    steel: '#83838d',
    signalBright: '#c9c9d1',
    signalMid: '#83838d',
    signalDim: '#6c6c76',
    danger: '#f0f0f3',
    dialogDanger: '#c4544d',
    success: '#f0f0f3',
    warning: '#b08a4a',
    accent: '#b08a4a',
    humanRail: '#b08a4a',
    agentRail: '#3b3048',
    radius: 3,
    ledgerBright: '#f0f0f3',
    ledgerBody: '#c9c9d1',
    ledgerQuiet: '#83838d',
    ledgerGhost: '#6c6c76',
    ledgerGlow: 'transparent',
    avatarGround: '#14091A',
    avatarInk: '#f0f0f3',
    avatarSoft: '#83838d',
    avatarDim: '#3b3048',
    agentAccent: '#b08a4a',
    borderQuiet: '#291e33',
    border: '#291e33',
    borderStrong: '#3b3048',
    focus: '#83838d',
    selectedBorder: '#83838d',
    selection: '#1e1326',
    muted: '#83838d',
    dim: '#83838d',
    gutter: '#6c6c76',
    faint: '#3b3048',
    tertiary: '#6c6c76',
    borderActive: '#83838d',
    proseRegular: 'SpaceGrotesk-Regular',
    proseItalic: 'IBMPlexSans-Italic',
    proseSemibold: 'SpaceGrotesk-SemiBold',
    monoRegular: 'IBMPlexMono-Regular',
    monoItalic: 'IBMPlexMono-Italic',
    monoSemibold: 'IBMPlexMono-SemiBold',
    // ONE message size: hierarchy on a long agent turn comes from weight
    // (proseMedium lead vs proseRegular body) and brightness, never size.
    proseSize: 16,
    proseLineHeight: 25,
    leadSize: 16,
    leadLineHeight: 25,
    // Turn separation is a hairline divider plus generous vertical padding,
    // not air alone.
    turnGap: 4,
    continuationGap: 0,
    turnPaddingVertical: 18,
    railWidth: 2,
    railInset: 12,
    // Editorial direction additions.
    proseMedium: 'SpaceGrotesk-Medium',
    turnDivider: '#1b1024',
    codeError: '#c98a8a',
  },
} as const;

export type BeelineThemeName = keyof typeof beelineThemes;
export type BeelineThemeTokens = (typeof beelineThemes)[BeelineThemeName];

/** Backward-compatible name for the new default token set. */
export const groknight = beelineThemes.obsidian;
export type GrokNightToken = keyof typeof groknight;
