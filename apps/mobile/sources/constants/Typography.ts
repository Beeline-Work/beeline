/**
 * Font families (DESIGN.md → Typography).
 *
 * One sans for everything a person reads: Space Grotesk. One mono for strings
 * a machine produced: IBM Plex Mono. Sizes and tracking come from the type
 * roles (`theme.buzz.type`), never from here.
 *
 * <Text style={{ ...theme.buzz.type.body, ...Typography.default('semiBold') }}>Title</Text>
 * <Text style={{ ...theme.buzz.type.machine, ...Typography.mono() }}>a1b2c3d</Text>
 */
export const FontFamilies = {
  sans: {
    regular: 'SpaceGrotesk-Regular',
    medium: 'SpaceGrotesk-Medium',
    semiBold: 'SpaceGrotesk-SemiBold',
  },
  mono: {
    regular: 'IBMPlexMono-Regular',
    italic: 'IBMPlexMono-Italic',
    semiBold: 'IBMPlexMono-SemiBold',
  },
} as const;

export const getDefaultFont = (weight: 'regular' | 'medium' | 'semiBold' = 'regular') =>
  FontFamilies.sans[weight];

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') =>
  FontFamilies.mono[weight];

export const Typography = {
  /** Space Grotesk: the face for everything a person reads. */
  default: (weight: 'regular' | 'medium' | 'semiBold' = 'regular') => ({
    fontFamily: getDefaultFont(weight),
  }),

  /** IBM Plex Mono: commands, paths, hashes, code, tool rows. */
  mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getMonoFont(weight),
  }),

  /** The transcript voice: the same Space Grotesk as `default`. */
  ledger: (weight: 'regular' | 'medium' | 'semiBold' = 'regular') => ({
    fontFamily: getDefaultFont(weight),
  }),
};
