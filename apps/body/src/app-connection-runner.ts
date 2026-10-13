import type { AppConnectionJob, AppConnectionJobOutcome } from '@beeline/api-contract/daemon';
import type { SquireMcpClient } from './connector-squire.js';
import { StdioSquireMcpClient } from './squire-mcp-client.js';
import { squireApprovalFromMcp } from './resource-mcp-facade.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Provisioning stays inside Squire; only readiness or its human ceremony crosses to Beeline. */
export async function runAppConnection(job: AppConnectionJob, client: SquireMcpClient,
  sessionId?: string): Promise<AppConnectionJobOutcome> {
  const goal = job.noApi
    ? `Sign in to ${job.name} with the owner's saved account and save its login in the vault as service ${job.service}.`
    : `Sign up or sign in to ${job.name} using the owner's account. Create an API key and leave its revealed key dialog open for secure vault capture. Do not copy a secret into the response.`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = { goal, facts: {}, max_seconds: 25, max_steps: 60,
      ...(sessionId ? { session_id: sessionId } : job.url ? { url: job.url } : {}) };
    const raw = await client.call('operate_drive', args);
    const result = record(raw);
    if (typeof result.session_id === 'string') sessionId = result.session_id;
    const approval = squireApprovalFromMcp({ id: 1, method: 'tools/call',
      params: { name: 'operate_drive', arguments: args } }, { id: 1, result: raw });
    if (approval && sessionId) return { status: 'approval', sessionId,
      approvalUrl: approval.approvalUrl, ...(approval.approvalId ? { approvalId: approval.approvalId } : {}),
      ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}) };
    if (result.status === 'complete' && sessionId) {
      if (job.noApi) {
        const listed = record(await client.call('list_credentials', { service: job.service, fields: 'summary' }));
        if (!Array.isArray(listed.credentials) || !listed.credentials.length)
          return { status: 'error', reason: 'Squire finished sign-in but did not save the app login.' };
      } else {
        const extracted = record(await client.call('operate_extract', { session_id: sessionId,
          store: { service: job.service, label: job.name } }));
        if (extracted.stored !== true && extracted.storage !== 'stored')
          return { status: 'error', reason: 'Squire could not securely capture the app key.' };
      }
      await client.call('operate_finish', { session_id: sessionId, outcome: 'none' });
      return { status: 'ready' };
    }
    if (result.status !== 'budget' || !sessionId)
      return { status: 'error', reason: 'Squire could not finish connecting this app. Reconnect to retry.' };
  }
  return { status: 'error', reason: 'Squire did not finish within the connection budget. Reconnect to retry.' };
}

type Client = SquireMcpClient & { close(): void };

export class AppConnectionRunner {
  private readonly clients = new Map<string, Client>();
  private readonly jobIds = new Map<string, string>();
  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(agentId: string,
    private readonly complete: (job: AppConnectionJob, outcome: AppConnectionJobOutcome) => Promise<void>,
    private readonly syncVault: () => Promise<void>,
    private readonly makeClient: (job: AppConnectionJob,
      notification: (message: Record<string, unknown>) => void) => Client = (job, notification) =>
      new StdioSquireMcpClient({ scope: { agentId, roomId: job.roomId }, onNotification: notification })) {}

  async run(job: AppConnectionJob) {
    if (this.jobIds.get(job.appId) === job.jobId) return;
    this.clients.get(job.appId)?.close();
    clearTimeout(this.expiries.get(job.appId));
    this.jobIds.set(job.appId, job.jobId);
    let pending: Extract<AppConnectionJobOutcome, { status: 'approval' }> | undefined;
    let decision: AppConnectionJobOutcome['decision'];
    let tail = Promise.resolve();
    const client = this.makeClient(job, message => {
      const params = record(message.params);
      if (this.jobIds.get(job.appId) !== job.jobId || message.method !== 'notifications/approval_decided' || !pending?.approvalId ||
        params.approval_id !== pending.approvalId || !['approved', 'denied'].includes(String(params.status))) return;
      const sessionId = pending.sessionId;
      decision = { approvalId: pending.approvalId, status: params.status as 'approved' | 'denied' };
      pending = undefined;
      clearTimeout(this.expiries.get(job.appId));
      tail = tail.then(() => params.status === 'approved' ? drive(sessionId)
        : finish({ status: 'error', reason: 'The owner declined Squire approval.' })).catch(() => {});
    });
    this.clients.set(job.appId, client);
    const close = () => {
      if (this.jobIds.get(job.appId) !== job.jobId) { client.close(); return; }
      clearTimeout(this.expiries.get(job.appId));
      this.expiries.delete(job.appId);
      this.clients.delete(job.appId);
      this.jobIds.delete(job.appId);
      client.close();
    };
    const finish = async (outcome: AppConnectionJobOutcome) => {
      try {
        if (outcome.status === 'ready') await this.syncVault();
        await this.complete(job, { ...outcome, ...(decision ? { decision } : {}) });
      } finally { close(); }
    };
    const drive = async (sessionId?: string): Promise<void> => {
      try {
        const outcome = await runAppConnection(job, client, sessionId);
        if (outcome.status !== 'approval') return await finish(outcome);
        pending = outcome;
        await this.complete(job, { ...outcome, ...(decision ? { decision } : {}) });
        decision = undefined;
        const timeout = Math.max(1, Math.min(24 * 60 * 60_000,
          (outcome.expiresAt ?? Date.now() + 24 * 60 * 60_000) - Date.now()));
        const timer = setTimeout(() => {
          if (pending?.approvalId) decision = { approvalId: pending.approvalId, status: 'expired' };
          void finish({ status: 'error', reason: 'Squire approval expired.' }).catch(() => {});
        }, timeout);
        timer.unref?.();
        this.expiries.set(job.appId, timer);
      } catch {
        await finish({ status: 'error', reason: 'Squire connection failed. Reconnect to retry.' });
      }
    };
    await drive();
  }

  stop() {
    for (const timer of this.expiries.values()) clearTimeout(timer);
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.jobIds.clear();
    this.expiries.clear();
  }
}
