#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Renders the Beeline brand asset set from THE ALLOY mark (canonical geometry,
# see sources/assets/images/mark.svg — do not redesign). Colorways are the
# Speakeasy-aligned tokens: ink #14091A canvas, brass #E5A645 mark.
#
# Requires rsvg-convert (librsvg2-bin) and ImageMagick.

brand_mark="$(node -p "require('./sources/buzz/brand.json').mark")"
ink="#14091A"
white="#FFFFFF"
image_dir="sources/assets/images"
font_file="sources/assets/fonts/BricolageGrotesque-Bold.ttf"

# Surface icons (favicon, splash) keep the previous mark's natural framing:
# the mark spans ~61% of the 1024 canvas (622px).
surface_mark_px=622
render_alloy_svg() {
  # $1 size, $2 mark height in px, $3 fill, $4 outfile; optional $5 = background rect fill
  local size="$1" mark_px="$2" fill="$3" out="$4" bg="${5:-}"
  local scale
  scale="$(node -p "($mark_px / 200).toFixed(6)")"
  {
    echo "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 $size $size\" width=\"$size\" height=\"$size\">"
    if [[ -n "$bg" ]]; then
      echo "<rect width=\"$size\" height=\"$size\" fill=\"$bg\"/>"
    fi
    echo "<g transform=\"translate($((size / 2)) $((size / 2))) scale($scale)\">"
    echo "<g transform=\"translate(-9,0)\">"
    echo "<path fill=\"$fill\" fill-rule=\"evenodd\" d=\"M 0 -100 A 100 100 0 0 0 0 100 L 100 100 L 100 -100 Z M 9 -58 L 67 42 L -49 42 Z\"/>"
    echo "</g></g></svg>"
  } | rsvg-convert >"$out"
}

recolor_svg() {
  # stdin -> stdout with one hex color swapped for another (case-insensitive)
  local from="$1" to="$2"
  sed "s/${from}/${to}/gI"
}

render_lockup() {
  local color="$1"
  local scale="$2"
  local destination="$3"
  local canvas_width=$((180 * scale))
  local canvas_height=$((154 * scale))
  # mark.svg draws the Alloy at ~81% of its raster (200/248 units); rasterize at
  # 90*scale so the drawn mark keeps the ~68px optical size the layout was designed for.
  local mark_size=$((90 * scale))
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

# App icon: brass gradient tile + ink mark.
rsvg-convert -w 1024 -h 1024 "$image_dir/icon.svg" -o "$image_dir/icon.png"

# Android adaptive icon: brass gradient background layer + ink foreground.
rsvg-convert -w 1024 -h 1024 "$image_dir/icon-adaptive-background.svg" \
  -o "$image_dir/icon-adaptive-background.png"
rsvg-convert -w 1024 -h 1024 "$image_dir/icon-adaptive.svg" \
  -o "$image_dir/icon-adaptive.png"
# Monochrome themed icon (Android 13): the same single silhouette in white.
rsvg-convert -w 1024 -h 1024 < <(recolor_svg "#14091A" "#FFFFFF" <"$image_dir/icon-adaptive.svg") \
  -o "$image_dir/icon-monochrome.png"

# Favicon + splash: brass mark on the Speakeasy ink field. The splash screens'
# backgroundColor in app.config.js must stay #14091A so the opaque tile blends in.
render_alloy_svg 1024 "$surface_mark_px" "$brand_mark" "$image_dir/favicon.png" "$ink"
cp "$image_dir/favicon.png" "$image_dir/splash-android-light.png"
cp "$image_dir/favicon.png" "$image_dir/splash-android-dark.png"

# Notification status-bar icon: white silhouette on transparent.
render_alloy_svg 512 311 "$white" "$image_dir/icon-notification.png"

# Legacy header logo (tinted at render time).
rsvg-convert -w 1024 -h 1024 "$image_dir/mark-dark.svg" -o "$image_dir/logo-black.png"

# Wordmark lockups for light and dark surfaces.
render_lockup "$ink" 1 "$image_dir/logotype-dark.png"
render_lockup "$ink" 2 "$image_dir/logotype-dark@2x.png"
render_lockup "$ink" 3 "$image_dir/logotype-dark@3x.png"
render_lockup "$brand_mark" 1 "$image_dir/logotype-light.png"
render_lockup "$brand_mark" 2 "$image_dir/logotype-light@2x.png"
render_lockup "$brand_mark" 3 "$image_dir/logotype-light@3x.png"

# Web active favicon + multi-resolution .ico.
rsvg-convert -w 240 -h 240 "$image_dir/favicon-active.svg" -o "$image_dir/favicon-active-rendered.png"
convert "$image_dir/favicon-active.svg" -define icon:auto-resize=48,32,16 public/favicon-active.ico
rm -f "$image_dir/favicon-active-rendered.png"

echo "Generated Beeline Alloy brand assets in ${brand_mark}, ${ink}, and ${white}."
