/**
 * GrokNight alien-hull palette.
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

  /** Brushed metal neutrals */
  chrome: '#c8c8c8',
  steel: '#6c6c6c',

  /** The only saturated color: primary, active, focus, live, and merge gate */
  accent: '#7dcfff',

  /** Borders */
  border: '#323237',
  borderActive: '#505058',
  selection: '#3c3c41',
} as const;

export type GrokNightToken = keyof typeof groknight;
