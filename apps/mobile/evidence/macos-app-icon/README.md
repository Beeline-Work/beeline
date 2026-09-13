# macOS app icon evidence

## Reproduced

`reproduced-square-128.png` is the previous shared desktop source downscaled to
128px. Its aubergine field reaches every canvas edge, so macOS renders it as a
hard square, and the brass mark occupies only about 40% of the canvas width.

## Demonstrated

`demonstrated-rounded-1024.png` is the new macOS-only master rendered by
`scripts/generate-tauri-icons.mjs`: an 824px centered aubergine plate with a
185px corner radius on transparency. The centered brass mark is 528px wide,
64.1% of the plate width.

`demonstrated-rounded-128.png` is the same generated master through the box
filter used for the smaller `.icns` entries. Linux PNGs and the Windows ICO
continue to use the original square source.
