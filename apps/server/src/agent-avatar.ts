import sharp from 'sharp';
import { normalizeAvatar } from './durable-avatar.js';

const colors = { bone: '#F2E9D8', ink: '#14091A', brass: '#E5A645', none: 'none' };
const attributes: Record<string, readonly string[]> = {
  path: ['d'],
  polygon: ['points'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx'],
  line: ['x1', 'y1', 'x2', 'y2'],
};

/** Only bounded geometry reaches librsvg: no caller XML, URLs, fonts or resources. */
export async function renderAgentAvatar(drawing: unknown): Promise<Buffer> {
  if (!Array.isArray(drawing) || drawing.length < 1 || drawing.length > 128)
    throw new Error('avatar needs 1–128 shapes');
  const shapes = drawing.map((shape: unknown) => {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape))
      throw new Error('invalid avatar shape');
    const item = shape as Record<string, unknown>;
    const type = item.type;
    if (typeof type !== 'string' || !Object.hasOwn(attributes, type))
      throw new Error('unsupported avatar shape');
    const allowed = attributes[type]!;
    const values: string[] = item.fill === undefined ? ['fill="none"'] : [];
    for (const [key, value] of Object.entries(item)) {
      if (key === 'type') continue;
      if (key === 'fill' || key === 'stroke') {
        if (typeof value !== 'string' || !Object.hasOwn(colors, value))
          throw new Error('invalid avatar color');
        values.push(`${key}="${colors[value as keyof typeof colors]}"`);
      } else if (allowed.includes(key) || key === 'strokeWidth') {
        if (key === 'd' || key === 'points') {
          const pattern = key === 'd' ? /^[MmLlHhVvCcSsQqTtAaZz0-9.,eE+\s-]+$/ : /^[0-9.,+\s-]+$/;
          if (
            typeof value !== 'string' ||
            !value.length ||
            value.length > 4000 ||
            !pattern.test(value)
          )
            throw new Error('invalid avatar path');
        } else if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 200) {
          throw new Error('invalid avatar coordinate');
        }
        values.push(`${key === 'strokeWidth' ? 'stroke-width' : key}="${value}"`);
      } else throw new Error('unsupported avatar attribute');
    }
    return `<${type} ${values.join(' ')} />`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100"><rect width="100" height="100" fill="${colors.brass}"/>${shapes.join('')}</svg>`;
  const png = await sharp(Buffer.from(svg), { limitInputPixels: 65536 }).png().toBuffer();
  const stats = await sharp(png).stats();
  if (stats.channels.every((channel) => channel.stdev < 0.01))
    throw new Error('invalid avatar: drawing is empty');
  return normalizeAvatar(png);
}
