export const LAYOUT_BREAKPOINTS = {
    compact: 0,
    regular: 800,
    wide: 1200,
} as const;

export type LayoutClass = keyof typeof LAYOUT_BREAKPOINTS;

export function getLayoutClass(width: number): LayoutClass {
    if (width >= LAYOUT_BREAKPOINTS.wide) return 'wide';
    if (width >= LAYOUT_BREAKPOINTS.regular) return 'regular';
    return 'compact';
}
