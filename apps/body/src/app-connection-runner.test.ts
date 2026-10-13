import { describe, expect, it, vi } from 'vitest';
import { AppConnectionRunner, runAppConnection } from './app-connection-runner.js';
import type { AppConnectionJob } from '@beeline/api-contract/daemon';

const job: AppConnectionJob = { appId: 'app', jobId: 'job', service: 'resend', name: 'Resend',
  url: 'https://resend.com', noApi: false, roomId: 'room', commandId: 'command', state: 'queued' };

describe('server-owned Squire connection work', () => {
  it('captures directly into the vault and returns only readiness', async () => {
    const call = vi.fn(async (tool: string) => tool === 'operate_drive'
      ? { status: 'complete', session_id: 'session' } : tool === 'operate_extract'
        ? { storage: 'stored', stored_credential: { reference: 'vault:fixture' } } : {});
    expect(await runAppConnection(job, { call })).toEqual({ status: 'ready' });
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['operate_drive', 'operate_extract', 'operate_finish']);
    expect(call).toHaveBeenCalledWith('operate_extract', { session_id: 'session', store: { service: 'resend', label: 'Resend' } });
  });

  it('resumes on Squire’s approval notification using the same session', async () => {
    let notify: (message: Record<string, unknown>) => void = () => {};
    let drives = 0;
    const call = vi.fn(async (tool: string) => {
      if (tool === 'operate_drive') return ++drives === 1
        ? { status: 'pending_approval', session_id: 'session', approval_url: 'https://trustysquire.com/approve/fixture', approval_id: 'fixture' }
        : { status: 'complete', session_id: 'session' };
      return tool === 'operate_extract' ? { storage: 'stored' } : {};
    });
    const close = vi.fn();
    const complete = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const runner = new AppConnectionRunner('agent', complete, sync, (_job, listener) => {
      notify = listener; return { call, close };
    });
    await runner.run(job);
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ status: 'approval', sessionId: 'session' });
    expect(close).not.toHaveBeenCalled();
    notify({ method: 'notifications/approval_decided', params: { approval_id: 'fixture', status: 'approved' } });
    await vi.waitFor(() => expect(complete).toHaveBeenLastCalledWith(job, { status: 'ready', decision: { approvalId: 'fixture', status: 'approved' } }));
    expect(call).toHaveBeenNthCalledWith(2, 'operate_drive', expect.objectContaining({ session_id: 'session' }));
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    runner.stop();
  });

  it('keeps a missing saved browser login as an error instead of claiming readiness', async () => {
    const call = vi.fn(async (tool: string) => tool === 'operate_drive'
      ? { status: 'complete', session_id: 'session' } : { credentials: [] });
    expect(await runAppConnection({ ...job, noApi: true }, { call })).toMatchObject({ status: 'error' });
  });
});
