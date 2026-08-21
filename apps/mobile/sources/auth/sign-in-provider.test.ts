import { describe, expect, it } from 'vitest';
import { nativeSignInLabel, nativeSignInProvider } from './sign-in-provider';

describe('native sign-in provider gate', () => {
  it('enables GitHub only when complete server config advertises it', () => {
    expect(nativeSignInProvider({ github: true })).toBe('github');
  });

  it('keeps the existing OIDC path when GitHub config is absent or undiscoverable', () => {
    expect(nativeSignInProvider({ github: false })).toBe('oidc');
    expect(nativeSignInProvider(undefined)).toBe('oidc');
  });
});

describe('native sign-in copy', () => {
  it('uses the captain-requested GitHub action label', () => {
    expect(nativeSignInLabel('github', false)).toBe('Continue with GitHub');
  });

  it('keeps the existing-device and Google labels', () => {
    expect(nativeSignInLabel('github', true)).toBe('Open Workspace');
    expect(nativeSignInLabel('oidc', false)).toBe('Continue with Google');
  });
});
