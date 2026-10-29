import type { VaultSaveRequest } from '@beeline/api-contract/daemon';
import { vaultSaveRequest, vaultSaveValues } from '@beeline/api-contract/daemon';

export interface VaultSaveSubmission {
  readonly attemptId: string;
  readonly cardId: string;
  readonly roomId: string;
  readonly request: VaultSaveRequest;
  readonly values: Record<string, string>;
}

/** Private helper path: neither tool arguments nor upstream errors reach a model or a log. */
export async function storeVaultSubmission(
  submission: VaultSaveSubmission,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<
  { status: 'saved'; reference: string; allowedHosts: readonly string[] } | { status: 'retry' }
> {
  let values: Record<string, string> | undefined;
  try {
    const request = vaultSaveRequest(submission.request);
    values = vaultSaveValues(request, submission.values);
    const result = await call('store_credential', {
      service: request.service,
      label: request.label,
      fields: values,
      auth_strategy: request.authStrategy,
      ...(request.authStrategy === 'username_password'
        ? { login_hosts: request.allowedHosts }
        : { api_hosts: request.allowedHosts }),
    });
    if (!result || typeof result !== 'object') return { status: 'retry' };
    const reference = (result as Record<string, unknown>).reference;
    // A reference is a name, never a free-form upstream response.
    if (
      typeof reference !== 'string' ||
      !/^vault:\/\/[a-zA-Z0-9_./:-]{1,240}$/.test(reference) ||
      Object.values(values).some((value) => value.length >= 8 && reference.includes(value))
    )
      return { status: 'retry' };
    const upstream = result as Record<string, unknown>;
    const allowedHosts =
      request.authStrategy === 'username_password' ? upstream.login_hosts : upstream.allowed_hosts;
    const effective =
      allowedHosts === undefined ? request : vaultSaveRequest({ ...request, allowedHosts });
    return { status: 'saved', reference, allowedHosts: effective.allowedHosts };
  } catch {
    return { status: 'retry' };
  } finally {
    if (values) for (const name of Object.keys(values)) delete values[name];
    for (const name of Object.keys(submission.values)) delete submission.values[name];
  }
}
