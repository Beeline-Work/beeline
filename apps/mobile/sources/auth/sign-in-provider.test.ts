import { describe, expect, it } from 'vitest';
import { nativeSignInProvider } from './sign-in-provider';

describe('native sign-in provider gate', () => {
  it('enables GitHub only when complete server config advertises it', () => {
    expect(nativeSignInProvider({ github: true })).toBe('github');
  });

  it('keeps the existing OIDC path when GitHub config is absent or undiscoverable', () => {
    expect(nativeSignInProvider({ github: false })).toBe('oidc');
    expect(nativeSignInProvider(undefined)).toBe('oidc');
  });
});
