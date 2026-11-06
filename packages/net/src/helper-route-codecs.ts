import type { RouteInput } from './routes.js';
import type { WireOutput } from './route-codecs.js';
import { helperShapes, helperOperations } from './generated-helper-shapes.js';
import { jsonCodec, type Codec } from './wire-codec.js';

/** Consumer-local schema projection; complete schemas. */
export function helperRouteCodecs<K extends keyof typeof helperOperations>(id: K): {
  params: Codec<RouteInput<K>>; result: Codec<WireOutput<K>>;
} {
  if (!Object.hasOwn(helperOperations, id)) throw new Error('Helper route unavailable');
  const contract = helperOperations[id];
  return {
    params: jsonCodec(helperShapes, contract.input, Infinity),
    result: jsonCodec(helperShapes, contract.output, Infinity),
  };
}
