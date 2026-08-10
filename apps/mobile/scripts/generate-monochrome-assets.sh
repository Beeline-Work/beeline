#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Change sources/buzz/brand.json, then run this script to swap the mark everywhere.
mark_color="$(node -p "require('./sources/buzz/brand.json').mark")"
surface_color="#090909"
icon_svg="sources/assets/images/icon.svg"
mark_svg="sources/assets/images/mark.svg"

sed -i -E "s/stroke=\"#[0-9a-fA-F]{6}\"/stroke=\"${mark_color}\"/" "$mark_svg"
sed -i -E "s/fill=\"#[0-9a-fA-F]{6}\"/fill=\"${surface_color}\"/; s/stroke=\"#[0-9a-fA-F]{6}\"/stroke=\"${mark_color}\"/" "$icon_svg"

convert -background none "$icon_svg" -resize 1024x1024 sources/assets/images/icon.png
convert -background none "$icon_svg" -resize 1024x1024 sources/assets/images/favicon.png
convert -background none "$icon_svg" -resize 1024x1024 sources/assets/images/splash-android-light.png
convert -background none "$icon_svg" -resize 1024x1024 sources/assets/images/splash-android-dark.png
convert -background none "$mark_svg" -resize 1024x1024 sources/assets/images/icon-adaptive.png

echo "Generated monochrome brand assets with mark ${mark_color} on ${surface_color}."
