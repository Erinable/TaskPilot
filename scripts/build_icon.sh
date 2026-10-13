#!/usr/bin/env bash
# Rebuilds assets/icon/icon.icns from the two SVG sources. Run by hand after
# editing them; the .icns is committed so packaging needs no extra tools.
# Needs rsvg-convert (brew install librsvg) and macOS iconutil.
set -euo pipefail

dir="$(cd -- "$(dirname -- "$0")/../assets/icon" && pwd -P)"
command -v rsvg-convert >/dev/null || { echo 'rsvg-convert not found: brew install librsvg' >&2; exit 1; }
command -v iconutil >/dev/null || { echo 'iconutil not found: this script runs on macOS' >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
set_dir="$work/icon.iconset"
mkdir "$set_dir"

# name px source
while read -r name px source; do
  rsvg-convert -w "$px" -h "$px" "$dir/$source" -o "$set_dir/$name.png"
done <<'EOF'
icon_16x16 16 icon_small.svg
icon_16x16@2x 32 icon_small.svg
icon_32x32 32 icon_small.svg
icon_32x32@2x 64 icon_small.svg
icon_128x128 128 icon.svg
icon_128x128@2x 256 icon.svg
icon_256x256 256 icon.svg
icon_256x256@2x 512 icon.svg
icon_512x512 512 icon.svg
icon_512x512@2x 1024 icon.svg
EOF

iconutil -c icns "$set_dir" -o "$dir/icon.icns"
echo "wrote $dir/icon.icns"
