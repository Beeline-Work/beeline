import brand from './brand.json';

/**
 * Grok Build palette measured from the 1.0.3 terminal capture.
 *
 * State is encoded primarily with copy, luminance, shape, and motion. The
 * muted-gold accent is reserved for a single live or high-value element,
 * including the Agent identity system.
 */
export const groknight = {
  /** Backgrounds */
  bgVoid: '#121212',
  bgTerminal: '#121212',
  bgBase: '#121212',
  bgRaised: '#121212',
  bgCode: '#121212',
  bgHighlight: '#121212',
  bgHover: '#181818',
  bgPressed: '#1e1e1e',
  bgTexturePeak: '#585858',
  bgVisual: '#181818',

  /** Text */
  textPrimary: '#e4e4e4',
  textSecondary: '#c9ccd1',
  textMuted: '#767676',
  textDisabled: '#6c6c6c',
  textInverted: '#121212',

  /** Semantic metal and state roles */
  actionFill: '#e4e4e4',
  chrome: '#e4e4e4',
  steel: '#767676',
  signalBright: '#c9ccd1',
  signalMid: '#767676',
  signalDim: '#585858',
  danger: '#c9ccd1',
  success: '#c9ccd1',
  warning: '#d7af5f',
  accent: '#d7af5f',
  brandMark: brand.mark,

  /** Diff view — the one sanctioned chroma exception to the zero-chroma
   * rule (captain override), reused from the legacy diff renderer's
   * dark-theme tokens so this file owns its own colors. */
  diffAdded: '#3FB950',
  diffRemoved: '#F85149',

  /** The single corner-radius value. No other radius ships. */
  radius: 3,

  /**
   * The ledger's luminance ladder — the transcript's ONLY hierarchy.
   *
   * Nothing in the transcript is loud by being fat; things are loud by being
   * bright. Weight is fixed at regular across the whole ledger, so these four
   * steps plus indentation carry every distinction the reader needs:
   *
   *   ledgerBright  the prophecy — live agent output, the lit layer
   *   ledgerBody    ordinary text — a person's own steer, quoted prose
   *   ledgerQuiet   handles, and the readable floor (4.5:1 on the slab)
   *   ledgerGhost   marginalia and collapsed machine noise, the dimmest tier
   *
   * `ledgerGhost` sits below 4.5:1 on purpose: it is the "ghosted" register the
   * brief asks for, and it reuses `textDisabled`'s exact value rather than
   * inventing a dimmer one. Everything it carries is redundant — the ghost
   * line's own `accessibilityLabel` states the full summary, and a gutter stamp
   * repeats information the row already conveys by position.
   */
  ledgerBright: '#f4f4f4',
  ledgerBody: '#b0b0b0',
  ledgerQuiet: '#7c7c7c',
  ledgerGhost: '#6c6c6c',

  /**
   * The transcript's luminous quality: agent output reads as lit from within
   * against the obsidian rather than printed on it. `ledgerBright` at low
   * alpha, used only as a zero-offset text shadow — a luminance value, not a
   * new hue, so it stays inside the zero-chroma rule. A whisper, not neon: the
   * radius is wide and the alpha low enough that the glow never thickens a
   * stroke or costs legibility.
   */
  ledgerGlow: 'rgba(244, 244, 244, 0.16)',

  /** Deterministic identity marks */
  avatarGround: '#121212',
  avatarInk: '#e4e4e4',
  avatarSoft: '#767676',
  avatarDim: '#4e4e4e',
  agentAccent: '#d7af5f',

  /** Human-selected profile pictures supplement the generated fallback mark. */
  photoIdentityMarksEnabled: true,

  /** Borders and selection */
  borderQuiet: '#4e4e4e',
  border: '#4e4e4e',
  borderStrong: '#4e4e4e',
  focus: '#767676',
  selectedBorder: '#767676',
  selection: '#181818',

  /** Compatibility aliases for non-semantic decoration only. */
  muted: '#767676',
  dim: '#767676',
  gutter: '#6c6c6c',
  faint: '#585858',
  tertiary: '#6c6c6c',
  borderActive: '#767676',
} as const;

export type GrokNightToken = keyof typeof groknight;
