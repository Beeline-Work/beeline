/** First word of a generated human-corner title. */
const ADJECTIVES = [
  'quiet',
  'bright',
  'hidden',
  'steady',
  'open',
  'still',
  'swift',
  'calm',
  'lucid',
  'spare',
] as const;

/** Second word of a generated human-corner title. */
const NOUNS = [
  'amber',
  'river',
  'cedar',
  'atlas',
  'harbor',
  'meadow',
  'lantern',
  'orchard',
  'granite',
  'willow',
] as const;

/**
 * A three-word corner title whose last word is always `corner`.
 * The Room header long-press uses this so a new human corner can open
 * without the title dialog.
 */
export function randomCornerName(random: () => number = Math.random): string {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] ?? ADJECTIVES[0];
  const noun = NOUNS[Math.floor(random() * NOUNS.length)] ?? NOUNS[0];
  return `${adjective} ${noun} corner`;
}
