#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

readonly source_icon="sources/assets/images/icon.svg"
readonly output_dir="store/assets"
readonly cyan="#52D7E8"
readonly ink="#14091A"
readonly paper="#F0F0F3"
readonly font="sources/assets/fonts/BricolageGrotesque-Bold.ttf"

mkdir -p "$output_dir"

# The mobile icon contains only a brass loop on the canonical aubergine field.
# Replace that exact flat color, preserving the locked loop path and framing.
render_icon() {
  local size="$1" output="$2"
  rsvg-convert -w "$size" -h "$size" "$source_icon" |
    convert png:- -alpha off -fill "$cyan" -opaque '#E5A645' \
      -depth 8 -type TrueColor -define png:exclude-chunk=date,time "PNG24:$output"
}

render_icon 512 "$output_dir/store-icon-512.png"
render_icon 1024 "$output_dir/ios-app-icon-1024.png"

convert -size 1024x500 "xc:$ink" \
  \( "$output_dir/store-icon-512.png" -resize 394x394 \) -geometry +72+53 -composite \
  -font "$font" -fill "$paper" -pointsize 74 -gravity northwest -annotate +500+148 'Beeline' \
  -font "$font" -fill "$paper" -pointsize 32 -gravity northwest \
  -annotate +504+246 'Steer and review' \
  -annotate +504+290 'AI coding agents' \
  -annotate +504+334 'from your phone.' \
  -alpha off -depth 8 -type TrueColor -define png:exclude-chunk=date,time \
  "PNG24:$output_dir/feature-graphic-1024x500.png"

identify "$output_dir/store-icon-512.png" "$output_dir/ios-app-icon-1024.png" \
  "$output_dir/feature-graphic-1024x500.png"
