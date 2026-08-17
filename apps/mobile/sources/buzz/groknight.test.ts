import { describe, expect, it } from 'vitest';
import { groknight } from './groknight';

describe('Grok Build palette', () => {
  it('keeps the measured terminal roles exact', () => {
    expect(groknight).toMatchObject({
      bgTerminal: '#121212',
      bgBase: '#121212',
      textPrimary: '#e4e4e4',
      textSecondary: '#c9ccd1',
      textMuted: '#767676',
      faint: '#585858',
      tertiary: '#6c6c6c',
      border: '#4e4e4e',
      accent: '#d7af5f',
      diffAdded: '#3FB950',
      diffRemoved: '#F85149',
      radius: 3,
    });
  });
});
