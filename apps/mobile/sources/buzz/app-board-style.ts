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

/** Type sizes from the four approved app boards, shared by their real surfaces. */
export const appBoardType = {
  eyebrow: { fontSize: 15 },
  title: { fontSize: 32, lineHeight: 40 },
  section: { fontSize: 12, letterSpacing: 3 },
  monoMark: { fontSize: 12 },
  rowTitle: { fontSize: 18 },
  rowValue: { fontSize: 15 },
  pickerName: { fontSize: 17 },
  meta: { fontSize: 14 },
  pickerAction: { fontSize: 14 },
  cardTitle: { fontSize: 17 },
  cardDetail: { fontSize: 14, lineHeight: 20 },
  cardAction: { fontSize: 15 },
  cardSettled: { fontSize: 11, letterSpacing: 1 },
} as const;
