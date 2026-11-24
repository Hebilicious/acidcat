export interface PlateFraming {
  readonly aspect: number;
  readonly focusX: number;
  readonly targetX: number;
  readonly zoom: number;
}

export const framingSpan = (width: number, height: number, framing: PlateFraming): { span: [number, number]; center: [number, number] } => {
  const viewAspect = width / height;
  const span: [number, number] = viewAspect > framing.aspect ? [1, framing.aspect / viewAspect] : [viewAspect / framing.aspect, 1];
  span[0] /= framing.zoom;
  span[1] /= framing.zoom;
  const clamp = (value: number, size: number) => Math.min(1 - size / 2, Math.max(size / 2, value));
  const centerX = clamp(framing.focusX - (framing.targetX - 0.5) * span[0], span[0]);
  return { span, center: [centerX, clamp(0.5, span[1])] };
};
