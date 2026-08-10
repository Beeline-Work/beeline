import brand from './brand.json';

/**
 * Grok Mono Hull palette.
 *
 * Every value is grayscale. State is encoded with luminance, shape, copy,
 * texture, and motion rather than a generic chromatic accent.
 */
export const groknight = {
  /** Backgrounds */
  bgVoid: '#090909',
  bgTerminal: '#090909',
  bgBase: '#111111',
  bgRaised: '#171717',
  bgCode: '#171717',
  bgHighlight: '#1d1d1d',
  bgHover: '#222222',
  bgPressed: '#292929',
  bgTexturePeak: '#303030',
  bgVisual: '#303030',

  /** Text */
  textPrimary: '#e8e8e8',
  textSecondary: '#c6c6c6',
  textMuted: '#929292',
  textDisabled: '#787878',
  textInverted: '#111111',

  /** Semantic metal and state roles */
  actionFill: '#dddddd',
  chrome: '#dddddd',
  steel: '#929292',
  signalBright: '#d8d8d8',
  signalMid: '#929292',
  signalDim: '#444444',
  danger: '#c6c6c6',
  success: '#d8d8d8',
  warning: '#c6c6c6',
  brandMark: brand.mark,

  /** Borders and selection */
  borderQuiet: '#303030',
  border: '#444444',
  borderStrong: '#606060',
  focus: '#b8b8b8',
  selectedBorder: '#b8b8b8',
  selection: '#222222',

  /** Compatibility aliases for non-semantic decoration only. */
  muted: '#929292',
  dim: '#787878',
  gutter: '#787878',
  borderActive: '#606060',
} as const;

export type GrokNightToken = keyof typeof groknight;
