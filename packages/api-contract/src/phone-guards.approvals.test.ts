import { describe, expect, it } from 'vitest';
import { readRoomViewMessage } from './phone-guards.js';

const agent = { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ruby', handle: 'ruby' };
const human = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Owner', handle: 'owner' };
const base = { id: 'c'.repeat(64), text: 'Approval', createdAt: 1792760000, author: agent, presentation: 'card' };
const squire = { agent, owner: human, tool: 'fetch_credential', title: 'Reveal a key', detail: 'Fly deploy key', approvalUrl: 'https://example.test/approval', linkKind: 'approval', action: 'reveal a key', reason: 'Deploy the preview.', reference: 'vault://owner/fly/key', facts: [{ label: 'Key', value: 'Fly deploy' }], decidedBy: human, decidedAt: 1792760240 };

describe('production approval message parsing', () => {
  it.each(['approved', 'denied', 'expired'])('preserves Squire %s state and presentation', status => {
    const payload = { ...squire, status };
    expect(readRoomViewMessage({ ...base, squireApproval: payload })?.squireApproval).toEqual(payload);
  });
  it.each(['allowed', 'denied'])('preserves target %s decision and purpose', status => {
    const targetBranch = { proposalId: 'proposal', from: 'main', to: 'release', agent, requester: human, purpose: 'Ship the fixes.', status, decidedBy: human, decidedAt: 1792760240 };
    expect(readRoomViewMessage({ ...base, targetBranch })?.targetBranch).toEqual(targetBranch);
  });
  it('preserves permission reason, timestamp and verified decision maker', () => {
    const permission = { permissionId: 'permission', requestId: 'request', agent, requester: human, tool: 'edit_file', status: 'allowed', reason: 'Update README.', decider: human, decidedAt: 1792760240 };
    expect(readRoomViewMessage({ ...base, permission })?.permission).toEqual(permission);
  });
  it('omits malformed optional fields and never treats an agent as the human decider', () => {
    const result = readRoomViewMessage({ ...base, squireApproval: { ...squire, owner: agent, decidedBy: agent, decidedAt: 'yesterday', status: 'other', action: {}, reason: [], reference: 9, facts: [{ label: 'Key', value: 9 }] }, targetBranch: { proposalId: 'p', from: 'main', to: 'release', decidedBy: agent, decidedAt: NaN, purpose: {}, status: 'other' } });
    expect(result?.squireApproval).toMatchObject({ agent, tool: 'fetch_credential' });
    for (const key of ['owner', 'decidedBy', 'decidedAt', 'status', 'action', 'reason', 'reference']) expect(result?.squireApproval).not.toHaveProperty(key);
    expect(result?.squireApproval?.facts).toEqual([]);
    for (const key of ['decidedBy', 'decidedAt', 'purpose', 'status']) expect(result?.targetBranch).not.toHaveProperty(key);
  });
});
