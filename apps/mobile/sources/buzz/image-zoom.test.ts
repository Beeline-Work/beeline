import { describe, expect, it } from 'vitest';
import { clampImageZoom, zoomImageAt } from './image-zoom';

const frame = { width: 400, height: 300 };

describe('image zoom bounds', () => {
  it('keeps the image in view and resets translation at fitted size', () => {
    expect(clampImageZoom({ scale: 1, x: 200, y: -100 }, frame)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampImageZoom({ scale: 2, x: 500, y: -500 }, frame)).toEqual({
      scale: 2,
      x: 200,
      y: -150,
    });
    expect(
      clampImageZoom(
        { scale: 2, x: 500, y: -500 },
        {
          ...frame,
          imageWidth: 800,
          imageHeight: 200,
        },
      ),
    ).toEqual({ scale: 2, x: 200, y: 0 });
  });

  it('zooms around the pointer and respects both limits', () => {
    expect(zoomImageAt({ scale: 1, x: 0, y: 0 }, 2, { x: 50, y: -30 }, frame)).toEqual({
      scale: 2,
      x: -50,
      y: 30,
    });
    expect(zoomImageAt({ scale: 2, x: 20, y: 0 }, 0.2, { x: 0, y: 0 }, frame)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
    expect(zoomImageAt({ scale: 2, x: 0, y: 0 }, 20, { x: 0, y: 0 }, frame).scale).toBe(5);
  });
});
