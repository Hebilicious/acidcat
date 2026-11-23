#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
out=../public/hero
mkdir -p "$out"

magick depth-wide.png matte-wide.png cut-mask-wide.png -colorspace gray -combine -define png:color-type=2 "$out/data.png"
magick key-art-wide.png -quality 94 -define webp:method=6 "$out/plate.webp"
if [ -f plate-wide@2x.png ]; then
  magick plate-wide@2x.png -unsharp 0x1.2+0.7+0.01 -quality 80 -define webp:method=6 "$out/plate@2x.webp"
fi
magick clean-plate-wide.png -quality 84 -define webp:method=6 "$out/clean.webp"
ls -la "$out"
