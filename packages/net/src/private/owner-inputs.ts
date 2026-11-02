import { ownerInputs, ownerInputShapes } from './generated-owner-input-shapes.js';
import { jsonCodec } from '../wire-codec.js';
const codecs = Object.fromEntries(Object.entries(ownerInputs).map(([route, node]) =>
  [route, jsonCodec(ownerInputShapes, node, 64 * 1024)]));
/** This projection grants no authority; it validates the owner's closed inputs. */
export function validateOwnerInput(route: keyof typeof ownerInputs, input: unknown): void {
  if (!Object.hasOwn(codecs, route)) throw new Error('network codec: undeclared owner route');
  codecs[route]!.parse(input);
}
