/** Approved Connect an app boards use Bone with these exact surface inks. */
export function appBoardColors(buzz: {
  bgTerminal: string; bgRaised: string; textPrimary: string; textSecondary: string;
  ledgerQuiet: string; border: string; borderStrong: string; accent: string;
}) {
  if (buzz.bgTerminal.toLowerCase() !== '#f3eee4') return {
    canvas: buzz.bgTerminal, tile: buzz.bgRaised, card: buzz.bgRaised,
    ink: buzz.textPrimary, secondary: buzz.textSecondary, quiet: buzz.ledgerQuiet,
    border: buzz.border, strongBorder: buzz.borderStrong, brass: buzz.accent,
  };
  return {
    canvas: '#F3EDE3', tile: '#FBF8F2', card: '#F8F3EA',
    ink: '#1C1712', secondary: '#3A332B', quiet: '#6F6558',
    border: '#E2D9CB', strongBorder: '#B8A27A', brass: '#7A5A1E',
  };
}
