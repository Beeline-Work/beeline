# Workbench app status marks

Workbench app rows and the app-detail status show the same state instrument:

| State        | Mark                             | Word tone                          |
| ------------ | -------------------------------- | ---------------------------------- |
| `connected`  | green check                      | `diffAdded` (Obsidian `#3FB950`, Bone `#1a7f37`) |
| `connecting` | amber spinner with an ambient glow | brass `accent` (Obsidian `#b08a4a`, Bone `#8a6323`) |
| `error`      | red failed dot                   | `dialogDanger` `#c4544d`           |

The word carries the state; the mark is redundant with it. The connecting
spinner respects reduced motion (a still amber ring) and its animation stops
when the state leaves `connecting` or the mark unmounts.

## Evidence

The proof paints the real Workbench screen (`list`) and the app-detail status
(`detail`) with one app in each state. Captured by:

```
cd apps/mobile
EVIDENCE=1 npx vitest run sources/components/buzz/AppStatusIndicator.browser.test.ts
```

- `obsidian-mobile-list.png`, `obsidian-desktop-list.png`
- `bone-mobile-list.png`, `bone-desktop-list.png`
- `obsidian-mobile-detail.png`, `bone-mobile-detail.png`

The same test also runs the proof without screenshots and asserts a green
check on the connected app, an amber spinner with its glow on the connecting
app, and the red failed dot on the erroring app, at phone and desktop widths
in both themes.

## Checks

- `npx vitest run sources/buzz/workbench.test.ts "sources/app/(app)/beeline/settings/workbench.test.tsx" "sources/app/(app)/beeline/settings/workbench/app.test.tsx"`
- `npx vitest run sources/buzz/design-lint.design.test.ts sources/buzz/calm-lint.design.test.ts`
- `npx vitest run sources/components/buzz/AppStatusIndicator.browser.test.ts`
- `npx tsc --noEmit`