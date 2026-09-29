import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

// Test Atlas tokens (medalis repo: --ink-*, --cream-*, --gold-500, --green-500, --loop-accent).
export const C = {
  slab: '#0d1814',
  raised: '#16211d',
  highlight: '#1e2e28',
  pressed: '#2a3e36',
  peak: '#3d5249',
  border: '#2a3e36',
  divider: '#16211d',
  bright: '#f4f1e8',
  body: '#ede9de',
  quiet: '#8a9690',
  ghost: '#5a6860',
  brass: '#c9a24a',
  mark: '#c9a24a',
  green: '#1e9963',
  leaf: '#58d792',
  added: '#58d792',
  removed: '#e5534b',
};

export const F = {
  prose: 'Space Grotesk',
  mono: 'DM Mono',
};

const fonts: Array<[string, string, string]> = [
  [F.prose, 'SpaceGrotesk-Regular.ttf', '400'],
  [F.prose, 'SpaceGrotesk-Medium.ttf', '500'],
  [F.prose, 'SpaceGrotesk-SemiBold.ttf', '600'],
  [F.prose, 'SpaceGrotesk-Bold.ttf', '700'],
  [F.mono, 'DMMono-Regular.ttf', '400'],
  [F.mono, 'DMMono-Medium.ttf', '500'],
];

export const fontsReady = Promise.all(
  fonts.map(([family, file, weight]) =>
    loadFont({family, url: staticFile(`fonts/${file}`), weight}),
  ),
);
