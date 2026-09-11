# App icon margin scoping

The mark's 146-unit height on its 240-unit source canvas left an average
47-unit vertical margin. The launcher treatment renders the mark at 83.260274%
of that linear size, producing a 121.56-unit mark and a 59.22-unit average
vertical margin: exactly 1.26 times the original margin.

That 26%-larger margin is a launcher treatment, not a logo treatment. It exists
so the mark keeps breathing room inside the Pixel launcher's mask. Anything
drawn unmasked wants the mark at its natural framing instead.

## The two framings

Two sources, deliberately distinct, both built from the same canonical loop
geometry in `sources/buzz/beeline-mark.json`:

- `icon.svg` → `icon.png` — the launcher framing, carrying the inset.
- `icon-full-bleed.svg` → `icon-full-bleed.png` — the same brass loop on the
  same aubergine field at its natural framing, with no inset.

`launcher-vs-full-bleed.png` shows the two generated 1024px renders side by
side: launcher left, full-bleed right.

Which surfaces take which:

| Surface | Source | Inset |
| --- | --- | --- |
| Android legacy launcher icon (`icon.png`) | `icon.svg` | yes |
| Android adaptive + monochrome foreground | `icon-adaptive.svg` | yes |
| iOS app icon (`icon-ios.png`) | `icon-full-bleed.png` | no |
| Web favicon (`favicon.png`) | `icon-full-bleed.png` | no |
| Android splash, light and dark | `icon-full-bleed.png` | no |
| Desktop icons (`src-tauri/icons/`) | `icon-full-bleed.png` | no |
| Sign-in mark (`BeelineMark`) | `beeline-mark.json` path | no |
| Notification icon | `mark.svg` | no |

iOS masks the app icon itself and expects artwork that reaches the edges, so it
takes the full-bleed render even though it lands on a home screen. Android
launcher icons are the only consumers of the inset.

## Why this is asserted in two places

The inset has twice reached the flat surfaces by way of a `cp icon.png`, most
recently when #357 and #464 re-shipped the icon set and restored the shared
copy that #116 had removed. A vector-only check did not catch it, because the
vectors were still correct — it was the rasterised copy that carried the inset.

So the scoping is now asserted on both representations:

- `scripts/generate-monochrome-assets.sh` refuses to rasterize unless each
  source carries the inset exactly when it should, in both directions.
- `sources/config/logoAssets.test.ts` hashes the shipped PNGs and requires every
  unmasked surface to be byte-identical to `icon-full-bleed.png` and different
  from `icon.png`.

Regenerate with `bash scripts/generate-monochrome-assets.sh`, then
`node scripts/generate-tauri-icons.mjs`. Note that the wordmark lockups and
`favicon-active.ico` go through ImageMagick's SVG delegate, so their bytes vary
with the local Inkscape and font versions; leave them alone unless their inputs
actually changed.

## Earlier captures

These API 36 (`emulator-5554`) images are from the original launcher scoping
change (#116) and show the launcher margin itself, which this change preserves
unaltered:

- `launcher-before.png`, `launcher-after.png`: the launcher inset landing.
- `launcher-scope-before-after.png`: launcher framing, unchanged by scoping.
- `splash-scope-before-after.png`, `favicon-scope-before-after.png`: splash and
  favicon dropping the launcher inset.
- `on-device-launcher-api36.png`, `on-device-splash-api36.png`,
  `web-favicon-production.png`: the installed launcher icon, splash and
  production favicon.
