import type { AuthCapabilities } from '@beeline/buzz-client';

export type NativeSignInProvider = 'github' | 'oidc';

/** GitHub is dark until the deployed auth service reports complete App config. */
export function nativeSignInProvider(
  capabilities: Pick<AuthCapabilities, 'github'> | undefined,
): NativeSignInProvider {
  return capabilities?.github === true ? 'github' : 'oidc';
}

export function nativeSignInLabel(provider: NativeSignInProvider, existingDevice: boolean): string {
  if (existingDevice) return 'Open Workspace';
  return provider === 'github' ? 'Continue with GitHub' : 'Continue with Google';
}
