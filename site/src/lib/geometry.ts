export interface Point {
  readonly x: number;
  readonly y: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export const polar = (cx: number, cy: number, radius: number, degrees: number): Point => {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: round(cx + radius * Math.cos(radians)), y: round(cy + radius * Math.sin(radians)) };
};

export interface GearOptions {
  readonly cx: number;
  readonly cy: number;
  readonly teeth: number;
  readonly outer: number;
  readonly root: number;
  readonly hole?: number;
}

export const gearPath = ({ cx, cy, teeth, outer, root, hole }: GearOptions): string => {
  const step = 360 / teeth;
  const parts: string[] = [];
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const start = tooth * step;
    const corners = [
      polar(cx, cy, root, start),
      polar(cx, cy, outer, start + step * 0.18),
      polar(cx, cy, outer, start + step * 0.42),
      polar(cx, cy, root, start + step * 0.6),
    ];
    const [first, ...rest] = corners;
    if (first === undefined) continue;
    parts.push(`${tooth === 0 ? "M" : "L"}${first.x} ${first.y}`);
    for (const corner of rest) parts.push(`L${corner.x} ${corner.y}`);
    const next = polar(cx, cy, root, start + step);
    parts.push(`A${root} ${root} 0 0 1 ${next.x} ${next.y}`);
  }
  parts.push("Z");
  if (hole !== undefined) {
    parts.push(`M${cx + hole} ${cy}A${hole} ${hole} 0 1 0 ${cx - hole} ${cy}A${hole} ${hole} 0 1 0 ${cx + hole} ${cy}Z`);
  }
  return parts.join("");
};
