export type ImageZoom = { scale: number; x: number; y: number };
export type ImageFrame = {
  width: number;
  height: number;
  imageWidth?: number;
  imageHeight?: number;
};

export const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 5;

export function clampImageZoom(value: ImageZoom, frame: ImageFrame): ImageZoom {
  const scale = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, value.scale));
  if (scale === 1) return { scale, x: 0, y: 0 };
  const fit =
    frame.imageWidth && frame.imageHeight
      ? Math.min(frame.width / frame.imageWidth, frame.height / frame.imageHeight)
      : 1;
  const width = frame.imageWidth ? frame.imageWidth * fit : frame.width;
  const height = frame.imageHeight ? frame.imageHeight * fit : frame.height;
  const maxX = Math.max(0, (width * scale - frame.width) / 2);
  const maxY = Math.max(0, (height * scale - frame.height) / 2);
  return {
    scale,
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, value.x)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, value.y)),
  };
}

export function zoomImageAt(
  current: ImageZoom,
  nextScale: number,
  focal: { x: number; y: number },
  frame: ImageFrame,
): ImageZoom {
  const scale = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, nextScale));
  const ratio = scale / current.scale;
  return clampImageZoom(
    {
      scale,
      x: focal.x - (focal.x - current.x) * ratio,
      y: focal.y - (focal.y - current.y) * ratio,
    },
    frame,
  );
}
