import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { FontFamilies, Typography, getDefaultFont, getMonoFont } from './Typography';

describe('Typography', () => {
  it('splits prose, and machine identity into bundled families', () => {
    expect(FontFamilies.default).not.toEqual(FontFamilies.mono);
    expect(getDefaultFont('regular')).toBe('IBMPlexSans-Regular');
    expect(getDefaultFont('italic')).toBe('IBMPlexSans-Italic');
    expect(getDefaultFont('semiBold')).toBe('IBMPlexSans-SemiBold');
    expect(getMonoFont('regular')).toBe('IBMPlexMono-Regular');
    expect(getMonoFont('italic')).toBe('IBMPlexMono-Italic');
    expect(getMonoFont('semiBold')).toBe('IBMPlexMono-SemiBold');
    expect(Typography.default().fontFamily).toBe('IBMPlexSans-Regular');
    expect(Typography.mono().fontFamily).toBe('IBMPlexMono-Regular');
  });
});
