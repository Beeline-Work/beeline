/** Approved Connect an app boards use Bone with these exact surface inks. */
export function appBoardColors(buzz: {
  appCanvas: string; appTile: string; appCard: string; appInk: string;
  appSecondary: string; appQuiet: string; appBorder: string;
  appStrongBorder: string; appCardBorder: string; accent: string;
  buttonPrimaryFill: string; buttonPrimaryText: string; buttonSecondaryText: string;
}) {
  return {
    canvas: buzz.appCanvas, tile: buzz.appTile, card: buzz.appCard,
    ink: buzz.appInk, secondary: buzz.appSecondary, quiet: buzz.appQuiet,
    border: buzz.appBorder, strongBorder: buzz.appStrongBorder,
    cardBorder: buzz.appCardBorder, brass: buzz.accent,
    buttonFill: buzz.buttonPrimaryFill, buttonText: buzz.buttonPrimaryText,
    buttonOutline: buzz.buttonSecondaryText,
  };
}
