import type { AuthSessionDiagnostics } from '@beeline/api-contract/signin-funnel';

let observed: Omit<AuthSessionDiagnostics, 'updateId'> = {};
const identifier = (value: unknown): string | undefined => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(text) ? text : undefined;
};

export function resetAuthSessionDiagnostics(): void {
  observed = {};
}

/** Retain identifiers only: callback URLs and localized error text contain private data. */
export function observeAuthSessionResult(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const value = result as Record<string, unknown>;
  observed = {
    resultType: identifier(value.type),
    errorDomain: identifier(value.errorDomain),
    errorCode: identifier(value.errorCode),
  };
}

export function authSessionDiagnostics(updateId: string, error?: unknown): AuthSessionDiagnostics {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return {
    ...observed,
    // Expo rejection codes and our recovery classification remain distinguishable
    // from NSError codes returned by the native session.
    errorDomain: observed.errorDomain ?? identifier(value.domain),
    errorCode: observed.errorCode ?? identifier(value.code),
    updateId,
  };
}
