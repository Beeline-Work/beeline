import type { StdioSquireMcpClient } from './squire-mcp-client.js';

export type SquireShareLease = { sessionId: string; upstreamUrl: string; expiresAt: number };
type Renewal = SquireShareLease & {
  client: StdioSquireMcpClient;
  timer?: ReturnType<typeof setTimeout>;
};

function shareResult(result: unknown): { upstreamUrl: string; expiresAt: number } {
  const envelope = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (envelope?.isError || !Array.isArray(envelope?.content)) throw new Error('Squire share renewal refused');
  const text = envelope.content.find(item => item.type === 'text')?.text;
  const body = JSON.parse(text ?? '{}') as { url?: unknown; expires_at?: unknown };
  const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
  if (typeof body.url !== 'string' || !/^https?:\/\/[^/]+\/s\/[A-Za-z0-9_-]{43}\/$/.test(body.url)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Squire share renewal returned an invalid lease');
  return { upstreamUrl: body.url, expiresAt };
}

/** Passive lease maintenance on the owning connection, independent of model turns. */
export class SquireShareRenewals {
  private readonly shares = new Map<string, Renewal>();

  constructor(
    private readonly owns: (sessionId: string, client: StdioSquireMcpClient) => boolean,
    private readonly persist: (lease: SquireShareLease) => Promise<boolean>,
    private readonly reaped: (sessionId: string) => void,
  ) {}

  track(sessionId: string, client: StdioSquireMcpClient, result: unknown): void {
    let lease: ReturnType<typeof shareResult>;
    try { lease = shareResult(result); } catch { return; }
    this.stop(sessionId);
    const share = { sessionId, client, ...lease };
    this.shares.set(sessionId, share);
    this.schedule(share);
  }

  stop(sessionId: string): void {
    const share = this.shares.get(sessionId);
    if (share?.timer) clearTimeout(share.timer);
    this.shares.delete(sessionId);
  }

  close(): void {
    for (const id of this.shares.keys()) this.stop(id);
  }

  private schedule(share: Renewal, retry = false): void {
    if (this.shares.get(share.sessionId) !== share) return;
    const remaining = share.expiresAt - Date.now();
    // Leave room for the MCP client's 210-second timeout and transport recovery.
    const margin = Math.min(4 * 60_000, Math.max(1, remaining / 2));
    const delay = retry ? 5_000 : Math.max(1, remaining - margin);
    share.timer = setTimeout(() => { void this.renew(share); }, delay);
    share.timer.unref?.();
  }

  private async renew(share: Renewal): Promise<void> {
    if (this.shares.get(share.sessionId) !== share) return;
    if (!this.owns(share.sessionId, share.client)) {
      this.stop(share.sessionId);
      this.reaped(share.sessionId);
      return;
    }
    try {
      const result = await share.client.requestMcp('tools/call', {
        name: 'operate_share', arguments: { session_id: share.sessionId },
      });
      if (this.shares.get(share.sessionId) !== share) return;
      if (!this.owns(share.sessionId, share.client)) {
        this.stop(share.sessionId);
        this.reaped(share.sessionId);
        return;
      }
      const lease = shareResult(result);
      if (lease.upstreamUrl !== share.upstreamUrl || lease.expiresAt <= share.expiresAt)
        throw new Error('Squire did not renew the existing share');
      if (!(await this.persist({ sessionId: share.sessionId, ...lease }))) {
        this.stop(share.sessionId);
        return;
      }
      share.expiresAt = lease.expiresAt;
      this.schedule(share);
    } catch {
      // Transport failures cannot end the browser. Retry on the same owner;
      // do not copy provider error text or bearer URLs into diagnostics.
      this.schedule(share, true);
    }
  }
}
