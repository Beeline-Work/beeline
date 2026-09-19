#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Renders the Beeline brand asset set from THE ORIGINAL CONTINUOUS-LINE LOOP
# (canonical geometry, see sources/assets/images/mark.svg — do not redesign).
# Owner-final colorway: brass #E5A645 mark on aubergine #14091A field.
#
# Requires rsvg-convert (librsvg2-bin) and ImageMagick.

brand_mark="$(node -p "require('./sources/buzz/brand.json').mark")"
ink="$(sed -n "s/^[[:space:]]*bgBase: '\(#[0-9A-Fa-f]\{6\}\)',/\1/p" sources/buzz/groknight.ts | head -1)"
white="#FFFFFF"
image_dir="sources/assets/images"
font_file="sources/assets/fonts/BricolageGrotesque-Bold.ttf"

if [[ -z "$ink" ]] || ! grep -qi "\`$ink\`" ../../DESIGN.md; then
  echo "Unable to prove the Obsidian bgBase token against DESIGN.md." >&2
  exit 1
fi

# The SVGs are reviewable build inputs, but the approved JSON files remain the
# geometry/color authorities. Refuse to rasterize if either representation has
# drifted instead of silently shipping a redesigned mark.
CANONICAL_INK="$ink" node <<'NODE'
const fs = require('node:fs');
const mark = require('./sources/buzz/beeline-mark.json');
const brand = require('./sources/buzz/brand.json');

const insetSources = ['icon-adaptive.svg', 'icon-monochrome.svg'];
const unmaskedSources = ['icon.svg', 'icon-light.svg', 'mark.svg'];

for (const file of [...insetSources, ...unmaskedSources]) {
  const svg = fs.readFileSync(`sources/assets/images/${file}`, 'utf8');
  const wantsInset = insetSources.includes(file);
  if (!svg.includes(mark.path) || svg.includes(mark.transform) !== wantsInset) {
    throw new Error(`${file} has the wrong masked/unmasked framing`);
  }
}

for (const file of ['mark.svg', 'icon.svg', 'icon-adaptive.svg']) {
  const svg = fs.readFileSync(`sources/assets/images/${file}`, 'utf8');
  if (!svg.includes(brand.mark)) throw new Error(`${file} does not use the approved mark color`);
}

for (const file of ['icon.svg', 'icon-adaptive-background.svg']) {
  const svg = fs.readFileSync(`sources/assets/images/${file}`, 'utf8');
  if (!svg.toLowerCase().includes(process.env.CANONICAL_INK.toLowerCase())) {
    throw new Error(`${file} does not use the canonical Obsidian bgBase token`);
  }
}
NODE

render_svg() {
  # $1 source svg, $2 size, $3 outfile
  rsvg-convert -w "$2" -h "$2" "$1" >"$3"
}

render_favicon_svg() {
  # Browser tabs render this at 16–24px. Keep the same loop, colors, and
  # unmasked canvas, but give the loop a dedicated 1.5x optical scale so it
  # remains as legible as neighboring favicons at that tiny size.
  sed \
    -e 's|<path |<g transform="translate(124.745 123) scale(1.5) translate(-124.745 -123)"><path |' \
    -e 's|</svg>|</g></svg>|' \
    "$image_dir/icon.svg" | rsvg-convert -w 1024 -h 1024 >"$image_dir/favicon.png"
}

render_notification_svg() {
  # White loop silhouette on transparent, sized for the status bar.
  local size="$1" out="$2"
  {
    echo "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 240 240\" width=\"$size\" height=\"$size\">"
    grep -o '<path d="[^"]*"' "$image_dir/mark.svg" | head -1 | sed "s|<path d=|<path fill=\"$white\" d=|" | sed 's|$|/>|'
    echo "</svg>"
  } | rsvg-convert >"$out"
}

render_lockup() {
  local color="$1"
  local scale="$2"
  local destination="$3"
  local canvas_width=$((180 * scale))
  local canvas_height=$((154 * scale))
  # mark.svg draws the loop on a 240-unit canvas at its natural framing; rasterize
  # at 112*scale so the drawn mark keeps the optical size the layout was designed for.
  local mark_size=$((112 * scale))
  local word_size=$((28 * scale))
  local word_y=$((112 * scale))
  local mark_source="$image_dir/mark.svg"

  if [[ "$color" == "$ink" ]]; then
    mark_source="$image_dir/mark-dark.svg"
  fi

  convert -size "${canvas_width}x${canvas_height}" xc:none \
    \( -background none "$mark_source" -resize "${mark_size}x${mark_size}" \) \
    -gravity north -geometry +0+0 -composite \
    \( -background none -fill "$color" -font "$font_file" -pointsize "$word_size" label:beeline \) \
    -gravity north -geometry "+0+${word_y}" -composite \
    -define png:exclude-chunk=date,time \
    "$destination"
}

# Unmasked icon surfaces use the natural loop framing. Expo consumes 1024px
# sources and emits every native density during prebuild.
render_svg "$image_dir/icon.svg" 1024 "$image_dir/icon.png"
render_svg "$image_dir/icon-light.svg" 1024 "$image_dir/icon-light.png"
cp "$image_dir/icon.png" "$image_dir/icon-ios.png"

# Android's foreground is masked down to the central safe zone and deliberately
# keeps the hand-tuned inset in icon-monochrome.svg. iOS uses the full-color
# icon above in every appearance mode so the brand does not become a grey tile.
render_svg "$image_dir/icon-monochrome.svg" 1024 "$image_dir/icon-adaptive-monochrome.png"

# Android adaptive icon: flat aubergine background layer + brass loop foreground.
rsvg-convert -w 1024 -h 1024 "$image_dir/icon-adaptive-background.svg" \
  -o "$image_dir/icon-adaptive-background.png"
rsvg-convert -w 1024 -h 1024 "$image_dir/icon-adaptive.svg" \
  -o "$image_dir/icon-adaptive.png"

# Splash uses the natural, unmasked framing. The favicon has a separate optical
# scale because its 16–24px browser surface is not an app-icon canvas.
render_favicon_svg
cp "$image_dir/icon-light.png" "$image_dir/splash-android-light.png"
cp "$image_dir/icon.png" "$image_dir/splash-android-dark.png"

# Play listing art is unmasked at source; keep its 512px upload in lockstep.
convert "$image_dir/icon.png" -resize 512x512 \
  -define png:exclude-chunk=date,time \
  fastlane/metadata/android/en-US/images/icon.png

# Notification status-bar icon: white silhouette on transparent.
render_notification_svg 512 "$image_dir/icon-notification.png"

# Legacy header logo (tinted at render time).
render_svg "$image_dir/mark-dark.svg" 1024 "$image_dir/logo-black.png"

# Wordmark lockups for light and dark surfaces.
render_lockup "$ink" 1 "$image_dir/logotype-dark.png"
render_lockup "$ink" 2 "$image_dir/logotype-dark@2x.png"
render_lockup "$ink" 3 "$image_dir/logotype-dark@3x.png"
render_lockup "$brand_mark" 1 "$image_dir/logotype-light.png"
render_lockup "$brand_mark" 2 "$image_dir/logotype-light@2x.png"
render_lockup "$brand_mark" 3 "$image_dir/logotype-light@3x.png"

# Web active favicon + multi-resolution .ico.
convert "$image_dir/favicon-active.svg" -define icon:auto-resize=48,32,16 public/favicon-active.ico

echo "Generated Beeline continuous-line brand assets in ${brand_mark} on ${ink}."
