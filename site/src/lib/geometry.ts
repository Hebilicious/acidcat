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

export interface Tick {
  readonly from: Point;
  readonly to: Point;
  readonly major: boolean;
}

export const ticks = (cx: number, cy: number, radius: number, count: number, length: number, majorEvery: number): Tick[] =>
  Array.from({ length: count }, (_, index) => {
    const major = index % majorEvery === 0;
    const degrees = (360 / count) * index;
    return {
      from: polar(cx, cy, radius, degrees),
      to: polar(cx, cy, radius - (major ? length * 2 : length), degrees),
      major,
    };
  });

export const circlePath = (cx: number, cy: number, radius: number): string =>
  `M${cx} ${cy - radius}A${radius} ${radius} 0 1 1 ${cx} ${cy + radius}A${radius} ${radius} 0 1 1 ${cx} ${cy - radius}`;

export type Cubic = readonly [Point, Point, Point, Point];

const cubicAt = ([p0, p1, p2, p3]: Cubic, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};

const densePoints = (curves: readonly Cubic[]): Point[] =>
  curves.flatMap((curve, index) =>
    Array.from({ length: 200 }, (_, step) => cubicAt(curve, step / 200)).concat(
      index === curves.length - 1 ? [cubicAt(curve, 1)] : [],
    ),
  );

export interface Segment {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

export const segmentsAlong = (curves: readonly Cubic[], length: number): Segment[] => {
  const points = densePoints(curves);
  const segments: Segment[] = [];
  let start = points[0];
  if (start === undefined) return segments;
  for (const point of points) {
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    if (distance < length) continue;
    segments.push({
      x: round((start.x + point.x) / 2),
      y: round((start.y + point.y) / 2),
      angle: round((Math.atan2(point.y - start.y, point.x - start.x) * 180) / Math.PI),
    });
    start = point;
  }
  return segments;
};

export const cubicPath = (curves: readonly Cubic[]): string =>
  curves
    .map(([p0, p1, p2, p3], index) => `${index === 0 ? `M${p0.x} ${p0.y}` : ""}C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`)
    .join("");

export const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};
