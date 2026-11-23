#!/usr/bin/env bash
# Writes the social sharing images into public/og/ from the wide key art, the logo and the Monaspace fonts.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=public/og
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

for face in xenon-latin-700 argon-latin-400 krypton-latin-500; do
  family=${face%%-latin-*}
  uv run --quiet --with fonttools --with brotli python - "node_modules/@fontsource/monaspace-$family/files/monaspace-$face-normal.woff2" "$work/$face.ttf" <<'PY'
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
font.flavor = None
font.save(sys.argv[2])
PY
done

magick art/key-art-wide.png -resize x630 -crop 1200x630+150+0 +repage "$work/art.png"
magick -size 1200x630 xc:'#05070b' \( -size 1200x630 xc: -fx 'max(0, min(0.94, 1.7 - i/480))' \) -alpha off -compose CopyOpacity -composite "$work/shade.png"
magick -background none -density 384 src/assets/mark.svg -resize 112x112 "$work/mark.png"

card() {
  local name=$1 eyebrow=$2 title=$3 line=$4
  magick "$work/art.png" "$work/shade.png" -composite \
    "$work/mark.png" -gravity northwest -geometry +72+64 -composite \
    -font "$work/krypton-latin-500.ttf" -pointsize 20 -fill '#ecc965' -kerning 4 -annotate +72+236 "$eyebrow" \
    -font "$work/xenon-latin-700.ttf" -pointsize 92 -fill '#f2e6c9' -kerning 0 -annotate +68+262 "$title" \
    -font "$work/argon-latin-400.ttf" -pointsize 28 -fill '#b9b09a' -interline-spacing 10 -annotate +72+392 "$line" \
    -fill '#b6ff3b' -draw 'rectangle 72,560 200,566' \
    -font "$work/krypton-latin-500.ttf" -pointsize 22 -fill '#b6ff3b' -kerning 3 -annotate +72+584 "acidcat.hebilicious.workers.dev" \
    -quality 86 "$out/$name.jpg"
}

card home "APPLICATION CAPABILITY IDENTIFICATION CATALOG" "AcidCat" $'Describe what your application\ncan do once. Serve it as a CLI,\nan MCP server, an HTTP API\nand typed code.'
card docs "ACIDCAT · DOCUMENTATION" "Docs" $'Quick start, concepts and\nguides for every language\nand core.'
card spec "ACIDCAT · SPECIFICATION 0.1" "Spec" $'The catalog, the bindings,\ninvocation, events and\nconformance.'
card packages "ACIDCAT · PACKAGES" "Packages" $'Catalog libraries, cores\nand tools on npm, crates.io,\nPyPI, Go and Pkl.'
ls -la "$out"
