import type { WebSocket } from 'ws';
import {
  PHONE_SOCKET_MAX_IN_FLIGHT, PHONE_SOCKET_MAX_REQUEST_ID_LENGTH,
  type PhoneRequestFrame, type PhoneResponseFrame,
} from '@beeline/api-contract/phone';
import { captureServerError } from './sentry.js';
import { PhoneOperationError, type PhoneOperationDispatcher } from './phone-operations.js';

/** Requests do not join the ordered subscription queue; each owns one bounded slot. */
export function phoneSocketRequests(
  client: WebSocket,
  viewerId: string,
  dispatch: PhoneOperationDispatcher,
  send: (frame: string) => unknown,
  errorStatus: (error: unknown) => number,
  /** Sign-in family of this socket, when the access token named one. */
  familyId?: string,
): (message: unknown) => boolean {
  const active = new Map<string, AbortController>();
  const abandon = () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
  };
  client.once('close', abandon);
  client.once('error', abandon);
  const reply = (frame: PhoneResponseFrame) => {
    if (client.readyState === client.OPEN) send(JSON.stringify(frame));
  };
  const fail = (id: string, code: string, message: string, retryable = false) =>
    reply({ t: 'res', id, ok: false, error: { code, message, retryable } });
  return (message) => {
    if (!message || typeof message !== 'object' || (message as { t?: unknown }).t !== 'req') return false;
    const request = message as Partial<PhoneRequestFrame>;
    const id = typeof request.id === 'string' ? request.id : '';
    if (!id || id.length > PHONE_SOCKET_MAX_REQUEST_ID_LENGTH ||
      typeof request.op !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(request.op) ||
      !request.args || typeof request.args !== 'object' || Array.isArray(request.args)) {
      fail(id.slice(0, PHONE_SOCKET_MAX_REQUEST_ID_LENGTH), 'invalid_request', 'Invalid phone request');
      return true;
    }
    if (active.has(id)) {
      fail(id, 'duplicate_id', 'Request id is already in flight');
      return true;
    }
    if (active.size >= PHONE_SOCKET_MAX_IN_FLIGHT) {
      fail(id, 'busy', 'Too many phone requests in flight', true);
      return true;
    }
    const controller = new AbortController();
    active.set(id, controller);
    void dispatch(request.op, request.args as Record<string, unknown>, viewerId, controller.signal, undefined, familyId)
      .then(result => {
        if (!controller.signal.aborted) reply({ t: 'res', id, ok: true, result: result ?? null });
      }, error => {
        if (controller.signal.aborted) return;
        const status = error instanceof PhoneOperationError ? error.status : errorStatus(error);
        if (status >= 500) captureServerError(error);
        const message = error instanceof Error ? error.message : 'request failed';
        const explicitCode = error instanceof PhoneOperationError ? error.payload.code ?? error.payload.error : undefined;
        const code = typeof explicitCode === 'string' && /^[a-z][a-z0-9_-]*$/.test(explicitCode) ? explicitCode
          : status === 400 ? 'invalid_args' : status === 401 ? 'unauthorized'
          : status === 403 ? 'access_denied' : status === 404 ? 'not_found'
          : status === 409 ? 'conflict' : status === 429 ? 'too_many_requests' : 'unavailable';
        fail(id, code, message, status === 429 || status >= 500);
      }).finally(() => active.delete(id));
    return true;
  };
}
