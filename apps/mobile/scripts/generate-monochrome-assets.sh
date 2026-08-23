#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Renders the Beeline brand asset set from THE ORIGINAL CONTINUOUS-LINE LOOP
# (canonical geometry, see sources/assets/images/mark.svg — do not redesign).
# Owner-final colorway: brass #E5A645 mark on aubergine #14091A field.
#
# Requires rsvg-convert (librsvg2-bin) and ImageMagick.

brand_mark="$(node -p "require('./sources/buzz/brand.json').mark")"
ink="#14091A"
white="#FFFFFF"
image_dir="sources/assets/images"
font_file="sources/assets/fonts/BricolageGrotesque-Bold.ttf"

render_svg() {
  # $1 source svg, $2 size, $3 outfile
  rsvg-convert -w "$2" -h "$2" "$1" >"$3"
}

recolor_svg() {
  # stdin -> stdout with one hex color swapped for another (case-insensitive)
  local from="$1" to="$2"
  sed "s/${from}/${to}/gI"
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

# App icon: brass loop on the flat aubergine tile (owner's explicit final choice).
render_svg "$image_dir/icon.svg" 1024 "$image_dir/icon.png"

# Android adaptive icon: flat aubergine background layer + brass loop foreground.
rsvg-convert -w 1024 -h 1024 "$image_dir/icon-adaptive-background.svg" \
  -o "$image_dir/icon-adaptive-background.png"
rsvg-convert -w 1024 -h 1024 "$image_dir/icon-adaptive.svg" \
  -o "$image_dir/icon-adaptive.png"
# Monochrome themed icon (Android 13): the same single silhouette in white.
rsvg-convert -w 1024 -h 1024 < <(recolor_svg "$brand_mark" "#FFFFFF" <"$image_dir/icon-adaptive.svg") \
  -o "$image_dir/icon-monochrome.png"

# Favicon + splash share the app icon's framing: brass loop on the aubergine
# field. The splash screens' backgroundColor in app.config.js must stay #14091A
# so the opaque tile blends in.
cp "$image_dir/icon.png" "$image_dir/favicon.png"
cp "$image_dir/icon.png" "$image_dir/splash-android-light.png"
cp "$image_dir/icon.png" "$image_dir/splash-android-dark.png"

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
