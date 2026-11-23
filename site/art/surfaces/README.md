# Surface renders

Each PNG is a source image from the built-in image generator. Each prompt starts with this direction.

> Square photoreal editorial studio product photograph for a brass-punk 2140 instrument catalogue. One complete object, centered occupying 78% width, front three-quarter perspective slightly above eye level. Worn machined brass, black enamel housings, polished chamfers and copper fittings. Warm grazing studio light, subtle cool rim light. Seamless midnight charcoal backdrop and dark bench with subtle grounding shadow. Rich metal detail. No typography, logos, border or captions.

Append the subject for the corresponding source.

- `cli.png` — Compact brass teletype computer with a convex green phosphor CRT prompt and a stepped mechanical keyboard.
- `mcp.png` — Compact rackmount relay server with three amber Nixie indicators, patch sockets and copper relay coils.
- `webmcp.png` — Freestanding brass browser porthole with a rectangular cyan glass window showing faint browser chrome and a few geometric interface elements.
- `http.png` — Pneumatic message-tube station with a clear upright glass cylinder, brass capsule and copper delivery bends.
- `ts.png` — Precision control lever with a knurled brass grip plugged into a machined socket, green indicator and indexed arc.

Resize each source to 720 × 720 pixels and encode it as WebP with ImageMagick, quality 82 and a target size of 66,000 bytes.
