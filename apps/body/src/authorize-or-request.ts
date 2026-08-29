import type {
  BeelineActionScope,
  BeelineActionToken,
  DirectToolResult,
  ReadMandateResult,
} from './agent-tool-contract.js';

export interface AuthorizeOrRequestInput<T> {
  action: BeelineActionToken;
  scope: BeelineActionScope;
  /** Host-derived from authenticated agent + active turn + normalized objective. */
  dedupKey: string;
  readMandate(): Promise<ReadMandateResult>;
  execute(mandate: ReadMandateResult): Promise<{ event_id: string; result: T }>;
  requestApproval(
    mandate: ReadMandateResult,
  ): Promise<{ request_id: string; event_id: string; message: string }>;
}

function safeFailure(error: unknown): DirectToolResult<never> {
  const known =
    error !== null && typeof error === 'object' && !Array.isArray(error)
      ? (error as { code?: unknown; retryable?: unknown; safeMessage?: unknown })
      : undefined;
  return {
    status: 'failed',
    code: typeof known?.code === 'string' ? known.code.slice(0, 80) : 'host_action_failed',
    retryable: known?.retryable === true,
    message:
      typeof known?.safeMessage === 'string'
        ? known.safeMessage.slice(0, 600)
        : 'The Beeline host could not complete this action.',
  };
}

function scopeContained(grant: BeelineActionScope, requested: BeelineActionScope): boolean {
  if (grant.type !== requested.type) return false;
  if (grant.workspaceId !== requested.workspaceId || grant.roomId !== requested.roomId) return false;
  if (grant.type === 'corner.open' && requested.type === 'corner.open') {
    return (
      grant.repositoryKey === requested.repositoryKey && grant.targetRef === requested.targetRef
    );
  }
  if (grant.type === 'corner.close' && requested.type === 'corner.close') {
    return (
      grant.cornerId === requested.cornerId &&
      grant.disposition === requested.disposition &&
      grant.repositoryKey === requested.repositoryKey &&
      grant.targetRef === requested.targetRef &&
      grant.sourceSha === requested.sourceSha
    );
  }
  return (
    grant.type === 'artifact.deliver' &&
    requested.type === 'artifact.deliver' &&
    grant.cornerId === requested.cornerId &&
    grant.audience === requested.audience
  );
}

/**
 * The single Phase-1 state-changing authority kernel.
 *
 * Calls are serialized per host-derived dedup key. A retry observes the same
 * promise/result and therefore cannot create a second corner or approval.
 * The current signed generation is read inside that serialization boundary;
 * executed actions bind the generation they were admitted against.
 */
export class AuthorizeOrRequestKernel {
  private readonly settled = new Map<string, DirectToolResult<unknown>>();
  private readonly inFlight = new Map<string, Promise<DirectToolResult<unknown>>>();

  authorizeOrRequest<T>(input: AuthorizeOrRequestInput<T>): Promise<DirectToolResult<T>> {
    const settled = this.settled.get(input.dedupKey);
    if (settled) return Promise.resolve(settled as DirectToolResult<T>);
    const active = this.inFlight.get(input.dedupKey);
    if (active) return active as Promise<DirectToolResult<T>>;
    const operation = this.run(input).then((result) => {
      this.settled.set(input.dedupKey, result);
      this.inFlight.delete(input.dedupKey);
      return result;
    });
    this.inFlight.set(input.dedupKey, operation);
    return operation;
  }

  private async run<T>(input: AuthorizeOrRequestInput<T>): Promise<DirectToolResult<T>> {
    try {
      const mandate = await input.readMandate();
      const defaultFact = mandate.defaults.find((entry) => entry.action === input.action);
      const covered = mandate.grants.some(
        (grant) => grant.action === input.action && scopeContained(grant.scope, input.scope),
      );
      if (covered || defaultFact?.effect === 'allow') {
        // Generation freshness is part of execution, not read_mandate advice.
        const current = await input.readMandate();
        if (
          current.generation.event_id !== mandate.generation.event_id ||
          current.generation.generation !== mandate.generation.generation
        ) {
          return {
            status: 'failed',
            code: 'mandate_generation_changed',
            retryable: true,
            message: 'Authority changed before execution. Retry against the current mandate.',
          };
        }
        const executed = await input.execute(current);
        return { status: 'executed', ...executed };
      }
      if (defaultFact?.effect === 'approval_required') {
        const pending = await input.requestApproval(mandate);
        return { status: 'approval_pending', ...pending };
      }
      return {
        status: 'denied',
        code: defaultFact ? 'mandate_denied' : 'unknown_action_default',
        message: defaultFact
          ? 'The current mandate denies this action.'
          : 'This action has no explicit default in the current mandate generation.',
      };
    } catch (error) {
      return safeFailure(error) as DirectToolResult<T>;
    }
  }
}

