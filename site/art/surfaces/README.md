# Surface icons

Each PNG is a transparent source render from the built-in image generator. Each prompt starts with this direction.

> One isolated floating precision instrument part for a brass-punk product catalog, on true transparent background. Photoreal macro studio product photography, 85mm lens viewing from slightly above in three-quarter view, near orthographic. Machined aged warm brass, polished chamfers, tiny slotted screws, graphite metal recesses. Warm softbox highlights from upper left. Simple bold silhouette readable at 120 pixels. Whole object centered, tight square composition. No floor, scenery, shadows outside object, cables, lettering, diagrams, borders or accessories.

Append the subject for the corresponding source.

- `cli.png` — A compact wedge-shaped brass terminal block. Its dominant feature is a black glass face with a single acid-green glowing >_ prompt. Three small physical keys on its lower lip.
- `mcp.png` — A squat horizontal dark steel server relay with brass corner caps, two cyan glass indicator lamps on top and three round brass connector ports on front.
- `webmcp.png` — A single slim brass browser-window bezel standing upright in landscape orientation, with a narrow top rail with three rivets, and one luminous cyan glass pane with subtle internal reflections. No stand or keyboard.
- `http.png` — A closed pneumatic mail capsule lying diagonally, with ribbed brass end caps, a clear glass central sleeve and a single rolled cream paper message inside.
- `ts.png` — An unplugged compact brass cylindrical electrical connector with three visible gold pins, dark insulating core, knurled brass finger grip. Floating diagonally, pins facing the viewer, no cable.

From the repository root, use ImageMagick to write the transparent web icons.

```sh
for id in cli mcp webmcp http ts; do
  magick "site/art/surfaces/$id.png" -trim +repage -resize 364x364 \
    -background none -gravity center -extent 384x384 -quality 83 \
    "site/src/assets/surfaces/$id.webp"
done
```
