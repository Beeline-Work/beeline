import { expect, it } from 'vitest';
import { appErrorCopy, connectionErrorTitle } from './app-error-copy';
it('explains network, timeout and server failures without diagnostics', () => {
  for (const reason of [new TypeError('Network request failed'), new Error('Request timed out'), { status: 504, code: 'surface_request_timed_out', message: 'Room view request failed (504 surface_request_timed_out)' }]) expect(appErrorCopy(reason, 'Could not load rooms.')).toBe(connectionErrorTitle);
});
it('preserves human client messages and uses the screen fallback for unknown failures', () => {
  expect(appErrorCopy({ status: 403, message: 'Only the owner can change this.' })).toBe('Only the owner can change this.');
  expect(appErrorCopy({ status: 400, code: 'invalid_name', message: 'Choose a shorter name.' })).toBe('Choose a shorter name.');
  expect(appErrorCopy({ status: 404, message: 'room_not_found' }, 'Could not load rooms.')).toBe('Could not load rooms.');
  expect(appErrorCopy(new Error('opaque'), 'Could not save settings.')).toBe('Could not save settings.');
  expect(appErrorCopy(undefined, 'Could not save settings.')).toBe('Could not save settings.');
});
it('preserves the server refusal sentence without its operation wrapper', () => {
  expect(appErrorCopy({ status: 403, code: 'Only the owner can change this.', message: 'Monolith updateWorkspace failed (403): Only the owner can change this.' })).toBe('Only the owner can change this.');
  expect(appErrorCopy({ status: 400, message: 'The timeout must be shorter.' })).toBe('The timeout must be shorter.');
  expect(appErrorCopy({ status: 400, message: 'Use fewer than 500 characters.' })).toBe('Use fewer than 500 characters.');
  expect(appErrorCopy(new Error('opaque_diagnostic'), 'Could not save settings.')).toBe('Could not save settings.');
});
