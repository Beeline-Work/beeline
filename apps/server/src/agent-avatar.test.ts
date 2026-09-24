import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderAgentAvatar } from './agent-avatar.js';

describe('generated avatar rendering', () => {
  it('renders different subjects to bounded durable images', async () => {
    const face = await renderAgentAvatar([
      { type: 'polygon', points: '20,20 80,20 70,80 50,92 30,80', fill: 'bone' },
      { type: 'circle', cx: 38, cy: 44, r: 8, fill: 'ink' },
      { type: 'circle', cx: 62, cy: 44, r: 8, fill: 'ink' },
    ]);
    const machine = await renderAgentAvatar([
      { type: 'rect', x: 10, y: 10, width: 80, height: 80, fill: 'ink' },
    ]);
    expect(face.equals(machine)).toBe(false);
    expect(await sharp(face).metadata()).toMatchObject({ width: 256, height: 256, format: 'webp' });
    expect(face.length).toBeLessThan(131072);
  });
  it.each(
    [
      [],
      new Array(129).fill({ type: 'circle' }),
      [{ type: 'image', href: 'https://example.com/image' }],
      [{ type: 'path', d: '<script />', fill: 'ink' }],
      [{ type: 'circle', cx: Infinity }],
      [{ type: 'circle', fill: 'url(file:///tmp/a)' }],
      [{ type: 'circle', onload: 'alert(1)' }],
      [{ type: 'circle', cx: 50, cy: 50, r: 20, fill: 'none' }],
    ].map((drawing) => ({ drawing })),
  )('refuses unsafe or unbounded drawings', async ({ drawing }) => {
    await expect(renderAgentAvatar(drawing)).rejects.toThrow();
  });
});
