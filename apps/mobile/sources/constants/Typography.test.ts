import { describe, expect, it } from 'vitest';

import { FontFamilies, Typography, getDefaultFont, getMonoFont } from './Typography';

describe('Typography', () => {
  it('splits prose and machine identity into two bundled families', () => {
    expect(FontFamilies.sans).not.toEqual(FontFamilies.mono);
    expect(getDefaultFont('regular')).toBe('SpaceGrotesk-Regular');
    expect(getDefaultFont('medium')).toBe('SpaceGrotesk-Medium');
    expect(getDefaultFont('semiBold')).toBe('SpaceGrotesk-SemiBold');
    expect(getMonoFont('regular')).toBe('IBMPlexMono-Regular');
    expect(getMonoFont('italic')).toBe('IBMPlexMono-Italic');
    expect(getMonoFont('semiBold')).toBe('IBMPlexMono-SemiBold');
  });

  it('renders the default face as Space Grotesk, never IBM Plex Sans', () => {
    expect(Typography.default().fontFamily).toBe('SpaceGrotesk-Regular');
    expect(Typography.default('semiBold').fontFamily).toBe('SpaceGrotesk-SemiBold');
    expect(Typography.ledger().fontFamily).toBe(Typography.default().fontFamily);
    expect(Typography.mono().fontFamily).toBe('IBMPlexMono-Regular');
  });
});
