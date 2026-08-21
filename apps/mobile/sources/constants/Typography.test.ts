import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { FontFamilies, Typography, getDefaultFont, getMonoFont, getSerifFont } from './Typography';

describe('Typography', () => {
  it('splits prose, machine identity, and editorial prose into bundled families', () => {
    expect(FontFamilies.default).not.toEqual(FontFamilies.mono);
    expect(getDefaultFont('regular')).toBe('IBMPlexSans-Regular');
    expect(getDefaultFont('italic')).toBe('IBMPlexSans-Italic');
    expect(getDefaultFont('semiBold')).toBe('IBMPlexSans-SemiBold');
    expect(getMonoFont('regular')).toBe('IBMPlexMono-Regular');
    expect(getMonoFont('italic')).toBe('IBMPlexMono-Italic');
    expect(getMonoFont('semiBold')).toBe('IBMPlexMono-SemiBold');
    expect(getSerifFont('regular')).toBe('IBMPlexSerif-Regular');
    expect(getSerifFont('italic')).toBe('IBMPlexSerif-Italic');
    expect(getSerifFont('semiBold')).toBe('IBMPlexSerif-SemiBold');
    expect(Typography.default().fontFamily).toBe('IBMPlexSans-Regular');
    expect(Typography.mono().fontFamily).toBe('IBMPlexMono-Regular');
    expect(Typography.serif().fontFamily).toBe('IBMPlexSerif-Regular');
  });
});
