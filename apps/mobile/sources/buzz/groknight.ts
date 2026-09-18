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
  // The one box radius, shared by every theme (DESIGN.md → Shape).
  radius: 3,
  // Human and agent relay photos defeat their identity axes, so their shared
  // photo gate stays off. Workspace pictures are the explicit exception and
  // are gated separately in photo-overrides.ts.
  photoIdentityMarksEnabled: false,
  transcriptCard: {
    cornerRadius: 10,
    marginTop: 8,
    marginBottom: 12,
    headTop: 14,
    side: 16,
    identitySize: 26,
    bodySize: 15,
    bodyLineHeight: 23,
    rowStateWidth: 92,
    rowVertical: 10,
    codeTop: 10,
    codeVertical: 10,
    codeHorizontal: 12,
    codeRadius: 8,
    codePathSize: 12,
    rowTitleSize: 15,
    rowKindSize: 12,
    footerTop: 12,
    footerVertical: 12,
    footerMinHeight: 44,
    actionGap: 22,
    actionSize: 15,
  },
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
  hero: {
    fontFamily: sans.medium,
    fontSize: 22,
    lineHeight: calmLineHeight(22),
    letterSpacing: -0.3,
  },
  /** Body text and row titles. */
  body: {
    fontFamily: sans.regular,
    fontSize: 16,
    lineHeight: calmLineHeight(16),
    letterSpacing: 0,
  },
  bodyStrong: {
    fontFamily: sans.semiBold,
    fontSize: 16,
    lineHeight: calmLineHeight(16),
    letterSpacing: 0,
  },
  /** Everything secondary: previews, captions, stamps, counts. Sans, never mono. */
  meta: {
    fontFamily: sans.regular,
    fontSize: 13,
    lineHeight: calmLineHeight(13),
    letterSpacing: 0,
  },
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
    // Diff green/red is the one domain-color exception (DESIGN.md), tuned
    // per canvas like brass is: legible text against near-black here, and
    // against Bone's near-white canvas in that theme's own values below.
    diffAdded: '#3FB950',
    diffRemoved: '#F85149',
    ledgerBright: '#f0f0f3',
    ledgerBody: '#c9c9d1',
    // The quiet tier carries the ledger's own reading matter — previews,
    // stamps, system lines, quoted reply/forward excerpts — so it holds a
    // WCAG-AA floor on every resting ground (bgBase, bgRaised/bgCode,
    // bgUnread). Pinned in groknight.test.ts; do not re-dim it.
    ledgerQuiet: '#90909B',
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
    brassWash: 'rgba(176,138,74,0.18)',
    brassWashStrong: 'rgba(176,138,74,0.28)',
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
    messageGap: 0,
    messagePaddingVertical: 6,
    railWidth: 2,
    railInset: 12,
    // Editorial direction additions.
    proseMedium: 'SpaceGrotesk-Medium',
    codeError: '#c98a8a',
  },
  // Bone: Obsidian Refined's light counterpart. Same construction rules as
  // Obsidian (design note 2026-09-14, DESIGN.md → Appearance) — a warm
  // canvas rather than a cold white, "content near-black, chrome mid" (the
  // inverse of Obsidian's "content near-white, chrome dim"), and every
  // elevation/border/divider step keeping the same relative position on the
  // ladder as its Obsidian counterpart, just re-based on the bone canvas.
  // Brass is darkened from Obsidian's `#b08a4a` to `#8a6323`: the shipped
  // brass is tuned for contrast against near-black and reads too light
  // against bone.
  bone: {
    ...shared,
    type: typeRoles,
    space,
    layout,
    name: 'bone',
    label: 'Bone',
    description: 'Readable sans prose on a quiet bone field',
    dark: false,
    bgVoid: '#F3EEE4',
    bgTerminal: '#F3EEE4',
    bgBase: '#F3EEE4',
    bgRaised: '#ECE4D5',
    bgCode: '#ECE4D5',
    bgHighlight: '#E4D9C4',
    bgUnread: '#EFE8DA',
    bgHover: '#E2D7C2',
    bgPressed: '#E0D5BE',
    bgTexturePeak: '#C9BBA0',
    bgVisual: '#ECE4D5',
    textPrimary: '#171310',
    textSecondary: '#4A4038',
    textMuted: '#8B7F6E',
    textDisabled: '#A79C89',
    textInverted: '#FBF8F2',
    actionFill: '#171310',
    chrome: '#8B7F6E',
    steel: '#8B7F6E',
    signalBright: '#4A4038',
    signalMid: '#8B7F6E',
    signalDim: '#A79C89',
    danger: '#171310',
    dialogDanger: '#c4544d',
    success: '#171310',
    warning: '#8a6323',
    accent: '#8a6323',
    humanRail: '#8a6323',
    agentRail: '#C9BBA0',
    // GitHub's current light-mode diff text green/red (not Obsidian's
    // #3FB950/#F85149 re-run at low contrast on a light canvas) — ~4.4:1 and
    // ~4.6:1 against Bone's bgBase, since these ship as text color in
    // TranscriptCard/ActivityTimeline/RoomMessageVariants, not swatches.
    diffAdded: '#1a7f37',
    diffRemoved: '#cf222e',
    ledgerBright: '#171310',
    ledgerBody: '#4A4038',
    // Darkened from #8B7F6E the way brass and diff text are: the gray shared
    // with chrome was tuned for near-black and fell below AA on the bone
    // canvas (3.4:1). The quiet tier holds the AA floor instead
    // (groknight.test.ts), so it no longer shares chrome's value.
    ledgerQuiet: '#6F6455',
    ledgerGhost: '#A79C89',
    ledgerGlow: 'transparent',
    avatarGround: '#F3EEE4',
    avatarInk: '#171310',
    avatarSoft: '#8B7F6E',
    avatarDim: '#C9BBA0',
    agentAccent: '#8a6323',
    borderQuiet: '#DED2BC',
    border: '#DED2BC',
    borderStrong: '#C9BBA0',
    focus: '#8B7F6E',
    selectedBorder: '#8B7F6E',
    selection: '#E4D9C4',
    muted: '#8B7F6E',
    dim: '#8B7F6E',
    gutter: '#A79C89',
    faint: '#C9BBA0',
    tertiary: '#A79C89',
    borderActive: '#8B7F6E',
    brassWash: 'rgba(138,99,35,0.18)',
    brassWashStrong: 'rgba(138,99,35,0.28)',
    proseRegular: 'SpaceGrotesk-Regular',
    proseItalic: 'IBMPlexSans-Italic',
    proseSemibold: 'SpaceGrotesk-SemiBold',
    monoRegular: 'IBMPlexMono-Regular',
    monoItalic: 'IBMPlexMono-Italic',
    monoSemibold: 'IBMPlexMono-SemiBold',
    proseSize: 16,
    proseLineHeight: 25,
    leadSize: 16,
    leadLineHeight: 25,
    messageGap: 0,
    messagePaddingVertical: 6,
    railWidth: 2,
    railInset: 12,
    proseMedium: 'SpaceGrotesk-Medium',
    codeError: '#a8524f',
  },
} as const;

export type BeelineThemeName = keyof typeof beelineThemes;
export type BeelineThemeTokens = (typeof beelineThemes)[BeelineThemeName];

/** Backward-compatible name for the new default token set. */
export const groknight = beelineThemes.obsidian;
export type GrokNightToken = keyof typeof groknight;
