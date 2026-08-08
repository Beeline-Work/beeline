/**
 * GrokNight Terminal — design tokens lifted from xai-org/grok-build groknight.rs.
 *
 * Central palette for Buzzy's mobile app. All buzzy screens import from here;
 * no hardcoded hex literals in screen styles.
 */
export const groknight = {
  /** Backgrounds */
  bgTerminal: '#0a0a0a',
  bgBase: '#141414',
  bgCode: '#1c1c1c',
  bgHighlight: '#242424',
  bgHover: '#2c2c2c',
  bgVisual: '#363636',

  /** Text */
  textPrimary: '#e1e1e1',
  textSecondary: '#c8c8c8',
  muted: '#6c6c6c',
  dim: '#585858',
  gutter: '#414141',

  /** Accents */
  magenta: '#bb9af7',
  blue: '#7aa2f7',
  cyan: '#7dcfff',
  green: '#9ece6a',
  greenDarkBg: '#063806',
  teal: '#1abc9c',
  red: '#f7768e',
  yellow: '#e0af68',
  orange: '#ff9e64',
  purple: '#9d7cd8',
  gold: '#ffdb8d',

  /** Borders */
  border: '#323237',
  borderActive: '#505058',
  selection: '#3c3c41',
} as const;

export type GrokNightToken = keyof typeof groknight;