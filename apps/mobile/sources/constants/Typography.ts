import { Platform } from 'react-native';

/**
 * Typography system for Happy Coder app
 *
 * Default/prose typography: IBM Plex Sans
 * Monospace typography: IBM Plex Mono
 * Transcript prose typography: Space Grotesk
 * Logo typography: Bricolage Grotesque (specific use only)
 *
 * Usage Examples:
 *
 * // Default typography (IBM Plex Mono)
 * <Text style={{ fontSize: 16, ...Typography.default() }}>Regular text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('italic') }}>Italic text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('semiBold') }}>Semi-bold text</Text>
 *
 * // Monospace typography (IBM Plex Mono)
 * <Text style={{ fontSize: 14, ...Typography.mono() }}>Code text</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('italic') }}>Italic code</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('semiBold') }}>Bold code</Text>
 *
 * // Logo typography (Bricolage Grotesque - use sparingly!)
 * // Note: Don't add fontWeight as this font is already bold
 * <Text style={{ fontSize: 28, ...Typography.logo() }}>Logo Text</Text>
 *
 * // Alternative direct usage
 * <Text style={{ fontSize: 16, fontFamily: getDefaultFont('semiBold') }}>Direct usage</Text>
 * <Text style={{ fontSize: 14, fontFamily: getMonoFont() }}>Direct mono usage</Text>
 * <Text style={{ fontSize: 28, fontFamily: getLogoFont() }}>Direct logo usage</Text>
 */

// Font family constants
export const FontFamilies = {
  // IBM Plex Sans (default prose typography)
  default: {
    regular: 'IBMPlexSans-Regular',
    italic: 'IBMPlexSans-Italic',
    semiBold: 'IBMPlexSans-SemiBold',
  },

  // IBM Plex Mono (default monospace)
  mono: {
    regular: 'IBMPlexMono-Regular',
    italic: 'IBMPlexMono-Italic',
    semiBold: 'IBMPlexMono-SemiBold',
  },

  // Space Grotesk (transcript prose)
  grotesk: {
    regular: 'SpaceGrotesk-Regular',
    medium: 'SpaceGrotesk-Medium',
    semiBold: 'SpaceGrotesk-SemiBold',
  },
  // Bricolage Grotesque (logo/special use only)
  logo: {
    bold: 'BricolageGrotesque-Bold',
  },
  
  // Legacy fonts (keep for backward compatibility)
  legacy: {
    systemMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  }
};

// Helper functions for easy access to font families
export const getDefaultFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return FontFamilies.default[weight];
};

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return FontFamilies.mono[weight];
};

export const getGroteskFont = (weight: 'regular' | 'medium' | 'semiBold' = 'regular') => {
  return FontFamilies.grotesk[weight];
};

export const getLogoFont = () => {
  return FontFamilies.logo.bold;
};

// Font weight mappings for the font families
export const FontWeights = {
  regular: '400',
  semiBold: '600', 
  bold: '700',
} as const;

// Style utilities for easy inline usage
export const Typography = {
  // Default font styles (IBM Plex Sans)
  default: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getDefaultFont(weight),
  }),
  
  // Monospace font styles (IBM Plex Mono)
  mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getMonoFont(weight),
  }),

  /**
   * The semantic Buzz transcript voice: Space Grotesk, the Obsidian `prose*`
   * families.
   */
  ledger: (weight: 'regular' | 'medium' | 'semiBold' = 'regular') => ({
    fontFamily:
      weight === 'medium'
        ? getGroteskFont('medium')
        : weight === 'semiBold'
          ? getGroteskFont('semiBold')
          : getGroteskFont('regular'),
  }),
  
  // Logo font style (Bricolage Grotesque)
  logo: () => ({
    fontFamily: getLogoFont(),
  }),
  
  // Header text style
  header: () => ({
    fontFamily: getDefaultFont('semiBold'),
  }),
  
  // Body text style
  body: () => ({
    fontFamily: getDefaultFont('regular'),
  }),
  
  // Legacy font styles (for backward compatibility)
  legacy: {
    systemMono: () => ({
      fontFamily: FontFamilies.legacy.systemMono,
    }),
  }
};
