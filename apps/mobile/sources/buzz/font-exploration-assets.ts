/**
 * THROWAWAY TYPE EXPLORATION — deleted with the rest of the toggle once the
 * captain picks a direction. See `font-exploration.ts` for the mechanics.
 *
 * Kept separate from `font-exploration.ts` on purpose: that module is imported
 * by `constants/Typography.ts` and therefore by node-environment unit tests,
 * which have no `.ttf` transform. Only `app/_layout.tsx` imports this file.
 */

/**
 * Every candidate family, keyed by the exact name the styles ask for. Spread
 * into the app's single `Fonts.loadAsync` call so switching direction never has
 * to load anything — only re-resolve which already-loaded name a style uses.
 */
export const EXPLORATION_FONT_ASSETS: Record<string, number> = {
  'CommitMono-Regular': require('@/assets/fonts/CommitMono-Regular.ttf'),
  'CommitMono-Italic': require('@/assets/fonts/CommitMono-Italic.ttf'),
  'CommitMono-Bold': require('@/assets/fonts/CommitMono-Bold.ttf'),

  'JetBrainsMono-Regular': require('@/assets/fonts/JetBrainsMono-Regular.ttf'),
  'JetBrainsMono-Italic': require('@/assets/fonts/JetBrainsMono-Italic.ttf'),
  'JetBrainsMono-SemiBold': require('@/assets/fonts/JetBrainsMono-SemiBold.ttf'),

  'Geist-Regular': require('@/assets/fonts/Geist-Regular.ttf'),
  'Geist-Italic': require('@/assets/fonts/Geist-Italic.ttf'),
  'Geist-SemiBold': require('@/assets/fonts/Geist-SemiBold.ttf'),
};
