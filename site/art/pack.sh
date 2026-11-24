#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
out=../src/assets/hero
mkdir -p "$out"

read -r crop_x crop_width < <(node --input-type=module -e 'import { phoneCrop } from "../src/lib/plate-crop.ts"; console.log(phoneCrop.x, phoneCrop.width)')
avif() { avifenc --speed 3 --yuv 444 --depth 8 --qcolor "$1" --jobs all "$2" "$3"; }

magick depth-wide.png matte-wide.png cut-mask-wide.png -colorspace gray -combine -strip -define webp:lossless=true -define webp:exact=true -define webp:method=6 "$out/data.webp"
magick key-art-wide.png -quality 94 -define webp:method=6 "$out/plate.webp"
avif 62 key-art-wide.png "$out/plate.avif"
magick key-art-wide.png -crop "${crop_width}x941+${crop_x}+0" +repage "$out/phone.png"
avif 62 "$out/phone.png" "$out/phone.avif"
magick "$out/phone.png" -filter Lanczos -resize 840x "$out/phone-840.png"
avif 62 "$out/phone-840.png" "$out/phone-840.avif"
if [ -f plate-wide@2x.png ]; then
  magick plate-wide@2x.png -unsharp 0x1.2+0.7+0.01 -quality 80 -define webp:method=6 "$out/plate@2x.webp"
  magick plate-wide@2x.png -unsharp 0x1.2+0.7+0.01 "$out/plate@2x.png"
  avif 56 "$out/plate@2x.png" "$out/plate@2x.avif"
  magick "$out/plate@2x.png" -crop "$((crop_width * 2))x1882+$((crop_x * 2))+0" +repage "$out/phone@2x.png"
  avif 56 "$out/phone@2x.png" "$out/phone@2x.avif"
  rm "$out/plate@2x.png" "$out/phone@2x.png"
fi
rm "$out/phone.png" "$out/phone-840.png"
magick clean-plate-wide.png -quality 84 -define webp:method=6 "$out/clean.webp"
avif 55 clean-plate-wide.png "$out/clean.avif"
ls -la "$out"
