import { Platform } from 'react-native';

/**
 * Typography system for Happy Coder app
 * 
 * Default typography: IBM Plex Sans
 * Monospace typography: IBM Plex Mono  
 * Logo typography: Bricolage Grotesque (specific use only)
 * 
 * Usage Examples:
 * 
 * // Default typography (IBM Plex Sans)
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
  // IBM Plex Sans (default typography)
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
   * The inscription voice — the Buzz transcript's body type.
   *
   * Resolves to IBM Plex Mono like `mono()`, but it is a different semantic
   * claim and must stay a separate seam: `mono()` marks a deliberate machine
   * identifier (a command, a handle, a role) and is governed by an allowlist,
   * while `ledger()` is *prose* set in the terminal face because the ledger is
   * an inscription rather than a chat feed.
   *
   * It takes no weight argument on purpose. Emphasis inside the ledger comes
   * from the `groknight.ledger*` luminance ladder and from indentation, never
   * from weight — and regular is the readable floor for light-on-black at this
   * size, so there is no lighter cut to reach for either (`DESIGN.md`, "Type").
   */
  ledger: () => ({
    fontFamily: getMonoFont('regular'),
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