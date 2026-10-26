import sharp from 'sharp';
import { resolveFace } from '@beeline/api-contract/phone';
import templates from './face-templates.generated.json' with { type: 'json' };
import { identityPalette } from './face-palette.generated.js';

/** Generated drawings and palette come from the same mobile face sources. */
export async function identityFaceDataUri(identity: { id: string; kind: 'agent' | 'human'; face_id: string | null }): Promise<string> {
  const face = resolveFace(identity.face_id, identity.id);
  const hue = identityPalette(identity.id, identity.kind).mid;
  const plate = identity.kind === 'agent' ? hue : '#F5EEE2';
  const drawing = templates[face][identity.kind].replaceAll('__HUE__', hue);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 100 100"><rect width="100" height="100" fill="${plate}"/>${drawing}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
