import { expect, it } from 'vitest';
import { appErrorCopy } from './app-error-copy';
it('explains network, timeout and server failures without diagnostics', () => {
  for (const reason of [new TypeError('Network request failed'), new Error('Request timed out'), { status: 504, code: 'surface_request_timed_out', message: 'Room view request failed (504 surface_request_timed_out)' }]) expect(appErrorCopy(reason, 'Could not load rooms.')).toBe('Could not load rooms.');
});
it('preserves human client messages and uses the screen fallback for unknown failures', () => {
  expect(appErrorCopy({ status: 403, message: 'Forbidden' })).toBe('Forbidden');
  expect(appErrorCopy({ status: 403, message: 'Only the owner can change this.' })).toBe('Only the owner can change this.');
  expect(appErrorCopy({ status: 400, code: 'invalid_name', message: 'Choose a shorter name.' })).toBe('Choose a shorter name.');
  expect(appErrorCopy({ status: 404, message: 'room_not_found' }, 'Could not load rooms.')).toBe('Could not load rooms.');
  expect(appErrorCopy(new Error('opaque'), 'Could not save settings.')).toBe('Could not save settings.');
  expect(appErrorCopy(new TypeError('Unexpected value returned'), 'Could not save settings.')).toBe('Could not save settings.');
  expect(appErrorCopy(undefined, 'Could not save settings.')).toBe('Could not save settings.');
});
it('preserves the server refusal sentence without its operation wrapper', () => {
  expect(appErrorCopy({ status: 403, code: 'Only the owner can change this.', message: 'Monolith updateWorkspace failed (403): Only the owner can change this.' })).toBe('Only the owner can change this.');
  expect(appErrorCopy({ status: 403, message: 'The request failed because only owners can change this.' })).toBe('The request failed because only owners can change this.');
  expect(appErrorCopy({ status: 400, message: 'The timeout must be shorter.' })).toBe('The timeout must be shorter.');
  expect(appErrorCopy({ status: 400, message: 'Use fewer than 500 characters.' })).toBe('Use fewer than 500 characters.');
  expect(appErrorCopy(new Error('opaque_diagnostic'), 'Could not save settings.')).toBe('Could not save settings.');
});

it('keeps human refusal messages from Error objects while hiding unknown diagnostics', () => {
  for (const message of ['Claude did not accept that code.', 'This connection belongs to another member.', 'Sign-in was denied', 'invalid face id'])
    expect(appErrorCopy(new Error(message))).toBe(message);
  for (const message of ['offline', 'Network unavailable', 'Connections did not answer. Try again.'])
    expect(appErrorCopy(new Error(message))).toBe('Could not complete request');
});

it('uses the screen fallback for runtime and RTC diagnostics', () => {
  for (const message of ['profile read failed', 'TLS roots missing', 'WebRTC failed before connecting', "Cannot read properties of undefined (reading name)"])
    expect(appErrorCopy(new Error(message), 'Conversation mode could not start')).toBe('Conversation mode could not start');
});

it('shows connection recovery after a live socket closes before its read answers', () => {
  expect(appErrorCopy(new Error('The connection closed before the server answered. The result is unknown.'))).toBe('Could not complete request');
});

it('leaves socket transport recovery to the global banner', () => {
  for (const name of ['PhoneSocketDisconnectedError', 'MonolithRequestTimeoutError'])
    expect(appErrorCopy(Object.assign(new Error('transport diagnostic'), { name, socketRequest: true }), 'Could not load rooms.')).toBe('');
  expect(appErrorCopy({ status: 0, code: 'timeout', message: 'timed out' })).toBe('');
});

it('keeps HTTP-only upload timeouts as action errors without diagnosing connectivity', () => {
  const error=Object.assign(new Error('Request timed out'), {name:'MonolithRequestTimeoutError'});
  expect(appErrorCopy(error,'Could not upload this photo.')).toBe('Could not upload this photo.');
});
