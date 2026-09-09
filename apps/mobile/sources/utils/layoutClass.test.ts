import { describe, expect, it } from 'vitest';
import { getLayoutClass, LAYOUT_BREAKPOINTS } from './layoutClass';

describe('layout classes', () => {
    it('keeps phone-width windows compact', () => {
        expect(getLayoutClass(320)).toBe('compact');
        expect(getLayoutClass(390)).toBe('compact');
        expect(getLayoutClass(LAYOUT_BREAKPOINTS.regular - 1)).toBe('compact');
    });

    it('uses regular for tablet-sized windows', () => {
        expect(getLayoutClass(LAYOUT_BREAKPOINTS.regular)).toBe('regular');
        expect(getLayoutClass(LAYOUT_BREAKPOINTS.wide - 1)).toBe('regular');
    });

    it('uses wide at the desktop boundary', () => {
        expect(getLayoutClass(LAYOUT_BREAKPOINTS.wide)).toBe('wide');
        expect(getLayoutClass(1600)).toBe('wide');
    });
});
