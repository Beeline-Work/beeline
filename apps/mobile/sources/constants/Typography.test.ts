import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { FontFamilies, Typography, getDefaultFont, getMonoFont } from './Typography';

describe('Typography', () => {
  it('resolves both prose (default) and machine (mono) text to IBM Plex Mono', () => {
    expect(FontFamilies.default).toEqual(FontFamilies.mono);
    expect(getDefaultFont('regular')).toBe('IBMPlexMono-Regular');
    expect(getDefaultFont('italic')).toBe('IBMPlexMono-Italic');
    expect(getDefaultFont('semiBold')).toBe('IBMPlexMono-SemiBold');
    expect(getMonoFont('regular')).toBe('IBMPlexMono-Regular');
    expect(getMonoFont('italic')).toBe('IBMPlexMono-Italic');
    expect(getMonoFont('semiBold')).toBe('IBMPlexMono-SemiBold');
    expect(Typography.default().fontFamily).toBe('IBMPlexMono-Regular');
    expect(Typography.mono().fontFamily).toBe('IBMPlexMono-Regular');
  });
});
