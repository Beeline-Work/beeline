import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { phoneInputs, phoneInputShapes } from './generated-phone-input-shapes.js';
import { jsonCodec } from './wire-codec.js';

type PhoneName = keyof PhoneOperationMap;
export type InputObservation = Readonly<{
  route: `phone.${PhoneName}` | 'undeclared';
  verdict: 'legacy-valid' | 'legacy-invalid' | 'wrong-transport' | 'undeclared';
}>;
const inputs: Readonly<Record<PhoneName, number | 'file-bytes'>> = phoneInputs;
const codecs = Object.fromEntries(Object.entries(inputs).map(([name, id]) =>
  [name, id === 'file-bytes' ? undefined : jsonCodec(phoneInputShapes, id, 64 * 1024)]));

/** Local migration evidence only. This function has no transport, pass,
 * authority, persistence, clock, telemetry or result-schema dependency. */
export function observePhoneInput(operation: unknown, input: unknown): InputObservation {
  if (typeof operation !== 'string' || !Object.hasOwn(inputs, operation))
    return { route: 'undeclared', verdict: 'undeclared' };
  const name = operation as PhoneName;
  const route = `phone.${name}` as const;
  if (inputs[name] === 'file-bytes') return { route, verdict: 'wrong-transport' };
  try { codecs[name]!.parse(input); return { route, verdict: 'legacy-valid' }; }
  catch { return { route, verdict: 'legacy-invalid' }; }
}
