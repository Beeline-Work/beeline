# Agent lead font — Android proof

Reproduction LEDGER-FONT-1: render an agent turn with the single paragraph
`My reply is ready. My reply stays easy to read.` through the production
`LedgerEntry` and `MonoMarkdown` on Android API 36 (1080×2400, density 420).

Before: the first sentence requests SpaceGrotesk-Medium, which is deliberately
unregistered in this fixture to model the owner's reported fallback. Its `y`
falls back to the Android system face; the second sentence uses the loaded
SpaceGrotesk-Regular. After: both sentences use SpaceGrotesk-Regular, including
its distinctive flat-bottomed `y`. Only the lead's brighter ink differs.

This is a native component stand-in, not the owner's signed-in device. The
owner's device/session is unavailable in this worktree. Expo Go 55.0.7 renders
the actual production Ledger and Markdown components; existing rail-proof
adapters replace Unistyles runtime and animation plumbing. Font loading in the
product is unchanged. The fixture loads Regular and mono, deliberately omitting
Medium for the fallback reproduction. Text is one multi-sentence paragraph;
the existing lead split renders the sentences as separate native blocks.

- `before-android.png`: native baseline (Expo developer chrome at the edge).
- `after-android.png`: same fixture after the font fix.
- `before-y-8x.png`, `after-y-8x.png`: left = first sentence's `y`, right =
  second sentence's `y`, enlarged exactly 8× with nearest-neighbor sampling.
  Source rectangles: `(96,343,124,384)` and `(96,405,124,446)`.

## Repeat

From `apps/mobile`, create a temporary `.ledger-font-proof` directory. Copy
`rail-proof/{metro.config.js,babel.config.js,animation-shim.js,unistyles-proof-shim.tsx,proof-theme.ts,interaction-proof-shim.tsx,identity-shim.js,responsive-shim.js}`
into it. Copy this directory's `fixture.jsx` to its `index.js`. Add
`export const cancelAnimation = () => {};` to its animation shim. Use
`{"name":"ledger-font-proof","private":true,"main":"index.js"}` as package.json,
and `{"expo":{"name":"Ledger font proof","slug":"ledger-font-proof","sdkVersion":"55.0.0"}}`
as app.json. Start `../node_modules/.bin/expo start --port 8173 --localhost --max-workers 2`
from that directory. Boot an isolated emulator with `beeline emulator`, install
Expo Go SDK 55, reverse port 8173 with adb, and open `exp://127.0.0.1:8173`.
Capture with `adb -s <device> exec-out screencap -p` after loading completes.
Use the same fixture on the baseline commit to reproduce the fallback.

## Regression and audit

The updated Ledger test fails on the baseline (Medium versus Regular) and all
41 Ledger tests pass after the fix. Root typecheck and UI component policy pass.

Other transcript family changes found and deliberately left unchanged:
`MonoMarkdown.tsx` italic spans use proseMedium (line 572), bold and headings
use proseSemibold (569, 579), and inline code uses monoRegular (573). The Medium
italic span is the other proseMedium occurrence inside message prose. Ledger's
remaining Medium styles belong to byline metadata and the system notice expand
control; TranscriptCard also uses Medium for handles and choice leaders.
No additional typography changes are included.
