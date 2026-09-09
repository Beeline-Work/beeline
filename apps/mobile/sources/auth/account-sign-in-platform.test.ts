import { describe, expect, it } from 'vitest';
import { accountSignInAvailable } from './account-sign-in-platform';

describe('account sign-in platform gate', () => {
  it('keeps ordinary web disabled but admits the Tauri desktop shell and native phones', () => {
    expect(accountSignInAvailable('web', false)).toBe(false);
    expect(accountSignInAvailable('web', true)).toBe(true);
    expect(accountSignInAvailable('android', false)).toBe(true);
    expect(accountSignInAvailable('ios', false)).toBe(true);
  });
});
