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

    it('holds a phone at compact even when it is wider than the threshold', () => {
        // iPhone 15 Pro Max in landscape is 932pt wide — wider than `regular`,
        // and still a one-column phone.
        expect(getLayoutClass(932, 'phone')).toBe('compact');
        expect(getLayoutClass(2000, 'phone')).toBe('compact');
    });

    it('classifies a tablet by its window width', () => {
        // iPad 9.7" portrait, the narrowest iPad.
        expect(getLayoutClass(768, 'tablet')).toBe('regular');
        // iPad Pro 12.9" landscape.
        expect(getLayoutClass(1366, 'tablet')).toBe('wide');
        // Split view: a tablet gets the one-column layout too.
        expect(getLayoutClass(507, 'tablet')).toBe('compact');
    });

    it('starts at zero, as unistyles breakpoints require', () => {
        expect(LAYOUT_BREAKPOINTS.compact).toBe(0);
        expect(LAYOUT_BREAKPOINTS.regular).toBeGreaterThan(LAYOUT_BREAKPOINTS.compact);
        expect(LAYOUT_BREAKPOINTS.wide).toBeGreaterThan(LAYOUT_BREAKPOINTS.regular);
    });
});
