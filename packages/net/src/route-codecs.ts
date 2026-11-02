import type { RouteId, RouteInput, RouteOutput } from './routes.js';
import { operationShapes, wireShapes } from './generated-wire-shapes.js';
import { jsonCodec, type Codec } from './wire-codec.js';

/** Socket dispatchers explicitly serialize void as null. Do not pretend that
 * the decoded wire response is undefined just because the service returns void. */
type OnWire<T> = T extends void ? null : T;
export type WireOutput<K extends RouteId> = OnWire<RouteOutput<K>>;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const uploadFields = { bytes: true, mimeType: true, name: true } as const satisfies Record<keyof RouteInput<'phone.uploadMedia'>, true>;

const fileBytesCodec: Codec<RouteInput<'phone.uploadMedia'>> = Object.freeze({
  parse(value: unknown): RouteInput<'phone.uploadMedia'> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error('network codec: file upload object required');
    // Inspect descriptors before reading: a codec never invokes caller getters.
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some(field => !('value' in field)))
      throw new Error('network codec: invalid upload fields');
    if (Object.keys(fields).some(key => !Object.hasOwn(uploadFields, key)))
      throw new Error('network codec: unknown upload field');
    const bytes: unknown = fields.bytes?.value;
    const mimeType: unknown = fields.mimeType?.value;
    const name: unknown = fields.name?.value;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES ||
      typeof mimeType !== 'string' || !mimeType.length || mimeType.length > 256 ||
      name !== undefined && (typeof name !== 'string' || name.length > 1024))
      throw new Error('network codec: invalid file upload');
    return { bytes, mimeType, ...(name === undefined ? {} : { name }) };
  },
});

// Exact mapping also makes new operations a compile failure until generated.
const contracts: { readonly [K in RouteId]: { readonly input: number | 'file-bytes'; readonly output: number } } = operationShapes;
export function routeCodecs<K extends RouteId>(id: K): {
  params: Codec<RouteInput<K>>; result: Codec<WireOutput<K>>;
} {
  const contract = contracts[id];
  return {
    params: contract.input === 'file-bytes'
      ? fileBytesCodec as Codec<RouteInput<K>>
      : jsonCodec(wireShapes, contract.input, MAX_INPUT_BYTES),
    result: jsonCodec(wireShapes, contract.output, MAX_ENVELOPE_BYTES),
  };
}
