import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { OwnedModelFiles, OwnedModelFileRefusal, OWNED_MODEL_FILE_MAX_BYTES,
  type OwnedModelFileBinding, type OwnedModelFileCredential } from './owned-model-files.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
const binding: OwnedModelFileBinding = { agentId: 'synthetic-agent', commandId: 'synthetic-command', generationId: 'generation-1',
  connectionId: 'connection-1', connectionEpoch: 1, provider: 'beeline', model: 'pinned-model', baseUrl: 'https://fixture.invalid/v1/free-agents/model' };
const credential = (): OwnedModelFileCredential => ({ v: 1, token, expiresAt: Math.floor(Date.now() / 1000) + 600 });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-model-files-')); roots.push(root);
  const granted = credential();
  return { root, granted, owner: OwnedModelFiles.create({ root, binding, credential: granted }) };
}
const journal = (owner: OwnedModelFiles) => JSON.parse(readFileSync(owner.paths().journal, 'utf8')) as {
  active: string | null; requests: { id: string; state: string }[] };

describe('owned model request journal capacity',()=>{
  it('compacts successful history through more than 128 provider requests without admitting UNKNOWN replay', () => {
    const {root, owner, granted}=fixture();let oldReceipt='';
    for(let index=0;index<256;index++){
      const request=owner.prepareHeaders();
      const signed=encodeOwnedModelReceipt(token,{requestId:request.requestId,state:'succeeded',evidence:{kind:'usage',tokens:1,usd:0}});
      if(oldReceipt)expect(owner.confirmReceipt(oldReceipt)).toBe(false);
      expect(owner.confirmReceipt(signed)).toBe(true);oldReceipt=signed;
      expect(journal(owner).requests.length).toBeLessThanOrEqual(1);
    }
    const request=owner.prepareHeaders();const restarted=OwnedModelFiles.create({root,binding,credential:granted});
    expect(restarted.snapshot()).toEqual({state:'unknown',requests:[request.requestId]});
    expect(()=>restarted.prepareHeaders()).toThrow(OwnedModelFileRefusal);
    expect(lstatSync(owner.paths().journal).size).toBeLessThan(OWNED_MODEL_FILE_MAX_BYTES);
  });

});
