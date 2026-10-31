import { randomUUID } from 'node:crypto';
import type { VaultSaveRequest } from '@beeline/api-contract/daemon';

export type VaultSaveAnswer =
  { status: 'saved'; reference: string; allowedHosts?: readonly string[] } | { status: 'retry' };

/** Process-local rendezvous. Values never enter LiveHub, PostgreSQL NOTIFY, or a job queue. */
export class VaultSaveRelay {
  constructor(readonly instanceId = process.env.FLY_MACHINE_ID ?? 'local') {}
  private readonly helpers = new Map<string, (frame: Record<string, unknown>) => boolean>();
  private readonly pending = new Map<
    string,
    { agentId: string; resolve: (answer: VaultSaveAnswer) => void }
  >();

  hasHelper(agentId: string): boolean {
    return this.helpers.has(agentId);
  }

  attach(agentId: string, send: (frame: Record<string, unknown>) => boolean): () => void {
    this.helpers.set(agentId, send);
    return () => {
      if (this.helpers.get(agentId) !== send) return;
      this.helpers.delete(agentId);
      for (const [attemptId, pending] of this.pending) {
        if (pending.agentId !== agentId) continue;
        this.pending.delete(attemptId);
        pending.resolve({ status: 'retry' });
      }
    };
  }

  answer(agentId: string, attemptId: unknown, answer: unknown): void {
    if (typeof attemptId !== 'string') return;
    const pending = this.pending.get(attemptId);
    if (!pending || pending.agentId !== agentId) return;
    const a = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
    this.pending.delete(attemptId);
    pending.resolve(
      a.status === 'saved' &&
        typeof a.reference === 'string' &&
        /^vault:\/\/[a-zA-Z0-9_./:-]{1,240}$/.test(a.reference)
        ? {
            status: 'saved',
            reference: a.reference,
            ...(Array.isArray(a.allowedHosts) &&
            a.allowedHosts.length <= 32 &&
            a.allowedHosts.every(
              (host) => typeof host === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host),
            )
              ? { allowedHosts: a.allowedHosts as string[] }
              : {}),
          }
        : { status: 'retry' },
    );
  }

  async submit(
    agentId: string,
    cardId: string,
    roomId: string,
    request: VaultSaveRequest,
    values: Record<string, string>,
    timeoutMs = 65_000,
    signal?: AbortSignal,
  ): Promise<VaultSaveAnswer> {
    const send = this.helpers.get(agentId);
    const attemptId = `${this.instanceId}:${randomUUID()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted || !send || this.pending.size >= 128) return { status: 'retry' };
      return await new Promise<VaultSaveAnswer>((resolve) => {
        this.pending.set(attemptId, { agentId, resolve });
        onAbort = () => resolve({ status: 'retry' });
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => resolve({ status: 'retry' }), timeoutMs);
        timer.unref?.();
        try {
          if (!send({ type: 'vault-save', attemptId, cardId, roomId, request, values }))
            resolve({ status: 'retry' });
        } catch {
          resolve({ status: 'retry' });
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      this.pending.delete(attemptId);
      for (const name of Object.keys(values)) delete values[name];
    }
  }
}
