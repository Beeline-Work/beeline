import { describe, expect, it } from 'vitest';
import { isArchivedChannelError } from './archived-channel.js';

describe('isArchivedChannelError', () => {
  it('matches the relay archived-channel refusal verbatim shape', () => {
    expect(
      isArchivedChannelError(
        new Error(
          'publishEvent kind=9002 failed: HTTP 400 {"error":"invalid: channel is archived"}',
        ),
      ),
    ).toBe(true);
    expect(
      isArchivedChannelError(
        new Error('publishEvent kind=9 failed: HTTP 400 {"error":"invalid: channel is archived"}'),
      ),
    ).toBe(true);
  });

  it('matches the refusal regardless of case or wrapper', () => {
    expect(isArchivedChannelError(new Error('Channel Is Archived'))).toBe(true);
    expect(isArchivedChannelError('invalid: channel is archived')).toBe(true);
  });

  it('refuses every other failure shape', () => {
    expect(isArchivedChannelError(new Error('HTTP 502 bad gateway'))).toBe(false);
    expect(isArchivedChannelError(new Error('invalid: bad signature'))).toBe(false);
    expect(isArchivedChannelError(undefined)).toBe(false);
    expect(isArchivedChannelError(null)).toBe(false);
  });
});
