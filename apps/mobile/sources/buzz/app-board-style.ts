/** Approved Connect an app boards use Bone with these exact surface inks. */
export function appBoardColors(buzz: {
  appCanvas: string; appTile: string; appCard: string; appInk: string;
  appSecondary: string; appQuiet: string; appBorder: string;
  appStrongBorder: string; appCardBorder: string; appBrass: string;
  buttonPrimaryFill: string; buttonPrimaryText: string; buttonSecondaryText: string;
}) {
  return {
    canvas: buzz.appCanvas, tile: buzz.appTile, card: buzz.appCard,
    ink: buzz.appInk, secondary: buzz.appSecondary, quiet: buzz.appQuiet,
    border: buzz.appBorder, strongBorder: buzz.appStrongBorder,
    cardBorder: buzz.appCardBorder, brass: buzz.appBrass,
    buttonFill: buzz.buttonPrimaryFill, buttonText: buzz.buttonPrimaryText,
    buttonOutline: buzz.buttonSecondaryText,
  };
}

/**
 * Type sizes from the four approved app boards. The header (eyebrow/title),
 * row/body text, and section captions now all come from the shared
 * `theme.buzz.type` roles instead — only the chat connector-offer card
 * (`RoomMessageVariants.tsx`, a different surface, out of this pass) still
 * keeps its own board-scale sizes.
 */
export const appBoardType = {
  cardTitle: { fontSize: 17 },
  cardDetail: { fontSize: 14, lineHeight: 20 },
  cardAction: { fontSize: 15 },
  cardSettled: { fontSize: 11, letterSpacing: 1 },
} as const;
