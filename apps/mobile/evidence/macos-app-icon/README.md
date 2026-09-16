# Desktop app icon evidence

## Reproduced

`reproduced-square-128.png` is the committed square source (`icon.png`)
downscaled to 128px — the treatment the browser shortcut art still ships via
`app.config.js`. Its aubergine field reaches every canvas edge and the brass
mark occupies only about 40% of the canvas width.

## Demonstrated

`demonstrated-rounded-1024.png` is the shared variant B master rendered by
`scripts/generate-tauri-icons.mjs` and used by every desktop platform: an
824px centered aubergine plate with a 185px corner radius and a subtle
diagonal gradient on transparency, with the committed brass loop composited
on it (lifted off its ground by a channel projection, never re-traced). The
centered brass mark is 528px wide, 64.1% of the plate width.

`demonstrated-rounded-128.png` is the same generated master through the box
filter used for the smaller `.icns`, PNG, and ICO entries. macOS previously
drew this exact plate with a flat aubergine fill, so the tile replaces it
one-for-one — its change is only the fill; Linux PNGs and the Windows ICO
gain the rounded plate together with the gradient.