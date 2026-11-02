import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { OwnedModelFiles } from './owned-model-files.js';
import { bindOwnedModelTurn, releaseOwnedModelTurn, ownedModelPrompt, OwnedModelOutcomeUnknown, ownedModelEndReceipt } from './owned-model-turn.js';
import { redactTurnError } from './turn-failure-reason.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-model-turn-')); roots.push(root);
  const owner = OwnedModelFiles.create({ root, binding: { agentId: 'agent', commandId: 'command', generationId: 'generation',
    connectionId: 'connection', connectionEpoch: 1, provider: 'beeline', model: 'model', baseUrl: 'https://fixture.invalid/v1/free-agents/model' },
    credential: { v: 1, token, expiresAt: Math.floor(Date.now() / 1000) + 600 } });
  const context = {}; bindOwnedModelTurn(context, owner); return { context, owner };
}
describe('owned model terminal interception before higher recovery', () => {
  it('leaves legacy tasks and their errors unchanged', async () => {
    expect(await ownedModelPrompt({}, async () => 'legacy')).toBe('legacy');
    const error = new Error('legacy refusal'); await expect(ownedModelPrompt({}, async () => { throw error; })).rejects.toBe(error);
  });
  it.each(['clean-acp-end', 'expired-login', 'failed-steer', 'device-grant', 'empty-provider', 'context-overflow'])(
    'UNKNOWN defeats %s before any retry, repair or dependent effect', async mode => {
      const { context, owner } = fixture(); const provider = vi.fn(), recovery = vi.fn();
      let requestId = '';
      const task = () => ownedModelPrompt(context, async () => {
        provider(); requestId = owner.prepareHeaders().requestId;
        if (mode === 'clean-acp-end') return { stopReason: 'end_turn' };
        throw new Error(mode === 'expired-login' ? 'Authentication required' : mode);
      });
      let error: unknown;
      try { await task(); recovery(); } catch (value) { error = value; }
      expect(error).toBeInstanceOf(OwnedModelOutcomeUnknown); expect(recovery).not.toHaveBeenCalled();
      const receipt = ownedModelEndReceipt(error as OwnedModelOutcomeUnknown,
        { agentId: 'agent', roomId: 'room', requestId: 'turn', generationId: 'generation' });
      expect(receipt).toEqual({ agentId: 'agent', roomId: 'room', requestId: 'turn', generationId: 'generation', status: 'failed', modelOwnerEnd: { requestId } });
      expect(JSON.stringify(receipt)).not.toContain(token); expect(receipt).not.toHaveProperty('reasonKind'); expect(receipt).not.toHaveProperty('trace');
      vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      await expect(task()).rejects.toBeInstanceOf(OwnedModelOutcomeUnknown); expect(provider).toHaveBeenCalledOnce();
    });
  it('authenticated committed success permits the actual next model/tool work', async () => {
    const { context, owner } = fixture(); const work = vi.fn();
    await ownedModelPrompt(context, async () => {
      const request = owner.prepareHeaders();
      expect(owner.confirmReceipt(encodeOwnedModelReceipt(token, { requestId: request.requestId, state: 'succeeded', evidence: { kind: 'usage', tokens: 1, usd: 0 } }))).toBe(true);
    });
    await ownedModelPrompt(context, async () => work()); expect(work).toHaveBeenCalledOnce();
  });
  it('defense-in-depth diagnostic redaction scrubs a bare owned bearer', () => {
    expect(redactTurnError(new Error('Synthetic bare token ' + token))).not.toContain(token);
  });
  it('explicit release after drain revokes the old file without erasing UNKNOWN', () => {
    const { context, owner } = fixture(); const request = owner.prepareHeaders();
    releaseOwnedModelTurn(context); expect(owner.snapshot()).toEqual({ state: 'unknown', requests: [request.requestId] });
    expect(() => owner.prepareHeaders()).toThrow();
  });
});
