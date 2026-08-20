import type { AuthCapabilities } from '@beeline/buzz-client';

export type NativeSignInProvider = 'github' | 'oidc';

/** GitHub is dark until the deployed auth service reports complete App config. */
export function nativeSignInProvider(
  capabilities: Pick<AuthCapabilities, 'github'> | undefined,
): NativeSignInProvider {
  return capabilities?.github === true ? 'github' : 'oidc';
}
