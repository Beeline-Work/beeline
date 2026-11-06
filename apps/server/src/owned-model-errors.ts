import { CommandRefusalError } from './command-refusal.js';

export class OwnedModelRefusal extends CommandRefusalError {
  constructor() { super('Owned model authority is unavailable', 403); }
}
export const OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE = 'Owned model outcome UNKNOWN blocks a new command generation';
export class OwnedModelUnknownGeneration extends CommandRefusalError {
  readonly state = 'unknown';
  constructor() { super(OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE, 409); }
}
/** Exact persisted floor refusal, including legacy SQL callers that do not
 * know the credential adapter. Never reinterpret another constraint failure. */
export function isOwnedModelUnknownGenerationError(error: unknown): boolean {
  return error instanceof OwnedModelUnknownGeneration || Boolean(error && typeof error === 'object' &&
    (error as { code?: unknown }).code === '23514' && (error as { message?: unknown }).message === OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE);
}
