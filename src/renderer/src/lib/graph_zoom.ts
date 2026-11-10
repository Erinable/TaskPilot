// Pan and zoom for a drawing shown in a fixed viewport: the drawing is moved
// by (x, y) and scaled by `scale` from its top-left corner. Pure, so the
// component only feeds it pointer positions and sizes.

export type Size = { width: number; height: number };
export type View = { scale: number; x: number; y: number };

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
// Space left around a fitted drawing, in pixels.
const FIT_MARGIN = 16;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

// Scales by `factor` keeping the drawing point under (pointX, pointY) in place.
export const zoomAt = (view: View, factor: number, pointX: number, pointY: number): View => {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return { scale, x: pointX - (pointX - view.x) * ratio, y: pointY - (pointY - view.y) * ratio };
};

// The whole drawing centred in the viewport, never enlarged past 1:1.
export const fitView = (content: Size, viewport: Size): View => {
  if (!content.width || !content.height) return { scale: 1, x: 0, y: 0 };
  const scale = clampScale(Math.min(1, (viewport.width - FIT_MARGIN * 2) / content.width, (viewport.height - FIT_MARGIN * 2) / content.height));
  return { scale, x: (viewport.width - content.width * scale) / 2, y: (viewport.height - content.height * scale) / 2 };
};

// Keeps at least `keep` pixels of the drawing inside the viewport, so a pan
// can never lose it off an edge.
export const clampPan = (view: View, content: Size, viewport: Size, keep = 48): View => {
  const width = content.width * view.scale;
  const height = content.height * view.scale;
  const x = Math.min(viewport.width - Math.min(keep, width), Math.max(Math.min(keep, width) - width, view.x));
  const y = Math.min(viewport.height - Math.min(keep, height), Math.max(Math.min(keep, height) - height, view.y));
  return { ...view, x, y };
};
