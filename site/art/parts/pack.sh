#!/bin/sh
set -eu

master=site/art/parts/master.webp
output=site/public/parts
mkdir -p "$output"
layer() {
  name=$1 height=$2 top=$3 outline=$4
  magick "$master" -crop "560x${height}+104+${top}" +repage \
    \( -size "560x${height}" xc:none -fill white -draw "polygon $outline" \) \
    -compose DstIn -composite -quality 88 "$output/$name.webp"
}

layer catalog 258 0 '0,0 559,0 559,222 365,222 345,257 217,257 185,222 0,222'
layer bindings 263 255 '0,0 189,0 200,15 360,15 370,0 559,0 559,230 311,230 299,248 291,254 280,260 271,257 262,248 250,230 0,230'
layer core 316 506 '0,0 259,0 268,6 280,10 292,6 300,0 559,0 559,315 0,315'
magick "$master" -crop 560x325+104+827 +repage -quality 88 "$output/conform.webp"
