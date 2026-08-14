#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

light_mark="$(node -p "require('./sources/buzz/brand.json').mark")"
dark_mark="#0b0b0d"
surface_color="#090909"
image_dir="sources/assets/images"
font_file="sources/assets/fonts/BricolageGrotesque-Bold.ttf"
# Launcher icons only: the mark is 146 units tall on its 240-unit source canvas, leaving an
# average 47-unit vertical margin. 59.22 / 47 = 1.26, so the new mark height
# is 121.56 units and the corresponding linear scale is 83.260274%.
launcher_mark_scale="83.260274%"

render_svg() {
  local source="$1"
  local geometry="$2"
  local destination="$3"
  convert -background none "$source" -resize "$geometry" \
    -define png:exclude-chunk=date,time "$destination"
}

render_launcher_foreground() {
  local source="$1"
  local geometry="$2"
  local destination="$3"
  convert -background none "$source" -resize "$geometry" \
    -resize "$launcher_mark_scale" -gravity center -extent "$geometry" \
    -define png:exclude-chunk=date,time "$destination"
}

render_surface_icon() {
  local source="$1"
  local geometry="$2"
  local destination="$3"
  convert -background "$surface_color" "$source" -resize "$geometry" \
    -background "$surface_color" -alpha remove \
    -define png:exclude-chunk=date,time "$destination"
}

render_lockup() {
  local color="$1"
  local scale="$2"
  local destination="$3"
  local canvas_width=$((180 * scale))
  local canvas_height=$((154 * scale))
  local mark_size=$((112 * scale))
  local word_size=$((28 * scale))
  local word_y=$((112 * scale))
  local mark_source="$image_dir/mark.svg"

  if [[ "$color" == "$dark_mark" ]]; then
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

render_svg "$image_dir/icon.svg" 1024x1024 "$image_dir/icon.png"
render_launcher_foreground "$image_dir/mark.svg" 1024x1024 "$image_dir/icon-adaptive.png"
render_launcher_foreground "$image_dir/mark.svg" 1024x1024 "$image_dir/icon-monochrome.png"
render_surface_icon "$image_dir/mark.svg" 1024x1024 "$image_dir/favicon.png"
render_surface_icon "$image_dir/mark.svg" 1024x1024 "$image_dir/splash-android-light.png"
render_surface_icon "$image_dir/mark.svg" 1024x1024 "$image_dir/splash-android-dark.png"
render_svg "$image_dir/mark.svg" 512x512 "$image_dir/icon-notification.png"
render_svg "$image_dir/mark-dark.svg" 1024x1024 "$image_dir/logo-black.png"

render_lockup "$dark_mark" 1 "$image_dir/logotype-dark.png"
render_lockup "$dark_mark" 2 "$image_dir/logotype-dark@2x.png"
render_lockup "$dark_mark" 3 "$image_dir/logotype-dark@3x.png"
render_lockup "$light_mark" 1 "$image_dir/logotype-light.png"
render_lockup "$light_mark" 2 "$image_dir/logotype-light@2x.png"
render_lockup "$light_mark" 3 "$image_dir/logotype-light@3x.png"

convert "$image_dir/favicon-active.svg" -define icon:auto-resize=48,32,16 public/favicon-active.ico

echo "Generated continuous-line brand assets in ${light_mark}, ${dark_mark}, and ${surface_color}."
