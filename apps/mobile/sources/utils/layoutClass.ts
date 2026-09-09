// The one source of truth for how wide a window has to be before the app
// changes shape. Pure: no React Native or platform imports, so `unistyles.ts`
// can configure its breakpoints from the same numbers the hooks read.
//
// 768 is the narrowest iPad portrait width, so every tablet held upright is at
// least `regular`; anything narrower is a single column (including a tablet in
// a split view).
export const LAYOUT_BREAKPOINTS = {
    compact: 0,
    regular: 768,
    wide: 1200,
} as const;

export type LayoutClass = keyof typeof LAYOUT_BREAKPOINTS;

export function getLayoutClass(width: number, deviceType?: 'phone' | 'tablet'): LayoutClass {
    // A phone is compact at every width. A large phone in landscape is wider
    // than the `regular` threshold but still has no room for a sidebar, so when
    // the caller knows it holds a handheld, the device wins over the measurement.
    if (deviceType === 'phone') return 'compact';

    if (width >= LAYOUT_BREAKPOINTS.wide) return 'wide';
    if (width >= LAYOUT_BREAKPOINTS.regular) return 'regular';
    return 'compact';
}
