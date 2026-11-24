#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
out=../public/hero
mkdir -p "$out"

magick depth-wide.png matte-wide.png cut-mask-wide.png -colorspace gray -combine -strip -define webp:lossless=true -define webp:exact=true -define webp:method=6 "$out/data.webp"
magick key-art-wide.png -quality 94 -define webp:method=6 "$out/plate.webp"
avifenc --speed 3 --yuv 444 --depth 8 --qcolor 62 --jobs all key-art-wide.png "$out/plate.avif"
if [ -f plate-wide@2x.png ]; then
  magick plate-wide@2x.png -unsharp 0x1.2+0.7+0.01 -quality 80 -define webp:method=6 "$out/plate@2x.webp"
fi
magick clean-plate-wide.png -quality 84 -define webp:method=6 "$out/clean.webp"
avifenc --speed 3 --yuv 444 --depth 8 --qcolor 55 --jobs all clean-plate-wide.png "$out/clean.avif"
ls -la "$out"
