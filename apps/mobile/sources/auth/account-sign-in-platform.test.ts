import { describe, expect, it } from 'vitest';
import { accountSignInAvailable } from './account-sign-in-platform';

describe('account sign-in platform gate', () => {
  it('admits the web workbench, Tauri shell, and native phones', () => {
    expect(accountSignInAvailable('web', false)).toBe(true);
    expect(accountSignInAvailable('web', true)).toBe(true);
    expect(accountSignInAvailable('android', false)).toBe(true);
    expect(accountSignInAvailable('ios', false)).toBe(true);
    expect(accountSignInAvailable('windows', false)).toBe(false);
  });
});
