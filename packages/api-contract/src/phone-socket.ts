import type { PhoneOperationMap } from './phone-operations.js';

/** Requests share the phone's authenticated live socket with subscription frames. */
export type PhoneRequestFrame<Name extends keyof PhoneOperationMap = keyof PhoneOperationMap> = { [Op in Name]: {
  readonly t: 'req';
  readonly id: string;
  readonly op: Op;
  readonly args: PhoneOperationMap[Op]['input'];
} }[Name];

export type PhoneResponseFrame<Result = unknown> =
  | { readonly t: 'res'; readonly id: string; readonly ok: true; readonly result: Result }
  | { readonly t: 'res'; readonly id: string; readonly ok: false; readonly error: {
      readonly code: string; readonly message: string; readonly retryable: boolean;
    } };

export const PHONE_SOCKET_MAX_IN_FLIGHT = 32;
export const PHONE_SOCKET_MAX_FRAME_BYTES = 64 * 1024;
export const PHONE_SOCKET_MAX_REQUEST_ID_LENGTH = 128;
