import { randomCornerName } from './random-corner-name';

export type OpenRandomNamedCornerInput = {
  createCorner: (roomId: string, title: string) => Promise<string>;
  roomId: string;
  openCorner: (cornerId: string, title: string) => void;
  random?: () => number;
};

/**
 * Long-press of the Room corners door: create a human corner whose name is
 * three words ending in `corner`, then open it.
 */
export async function openRandomNamedCorner(
  input: OpenRandomNamedCornerInput,
): Promise<{ id: string; title: string }> {
  const title = randomCornerName(input.random);
  const id = await input.createCorner(input.roomId, title);
  input.openCorner(id, title);
  return { id, title };
}
