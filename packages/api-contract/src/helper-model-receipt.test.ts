import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { OwnedModelAttemptReceipt } from './helper-model.js';
import { encodeOwnedModelReceipt, readOwnedModelReceipt, OWNED_MODEL_RECEIPT_MAX_CHARS } from './helper-model-receipt.js';

const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
const id = '11111111-1111-4111-8111-111111111111';
const success: OwnedModelAttemptReceipt = { requestId: id, state: 'succeeded', evidence: { kind: 'usage', tokens: 42, usd: 0.001 } };
function retag(bytes: string): string {
  const body = Buffer.from(bytes).toString('base64url');
  const key = createHmac('sha256', token).update('beeline:owned-model:receipt:key:v1\0').digest();
  const tag = createHmac('sha256', key).update('beeline:owned-model:receipt:tag:v1\0').update(body).digest('hex');
  return 'bfmr_v1.' + body + '.' + tag;
}
describe('owned model same-stream receipt', () => {
  it.each<OwnedModelAttemptReceipt>([success, { requestId: id, state: 'unknown' },
    ...(['authority', 'queue', 'cancelled', 'deadline'] as const).map(reason => ({ requestId: id, state: 'refused' as const, evidence: { kind: 'not-dispatched' as const, reason } })),
    { requestId: id, state: 'refused', evidence: { kind: 'provider-refused', status: 429 } }])('roundtrips closed durable outcome %j', receipt => {
    const encoded = encodeOwnedModelReceipt(token, receipt);
    expect(encoded.length).toBeLessThanOrEqual(OWNED_MODEL_RECEIPT_MAX_CHARS);
    expect(encoded).not.toContain(token); expect(readOwnedModelReceipt(encoded, token, id)).toEqual(receipt);
  });
  it('binds both request UUID and complete credential, and refuses upstream-looking ids', () => {
    const encoded = encodeOwnedModelReceipt(token, success);
    expect(readOwnedModelReceipt(encoded, token, id.replace(/1/g, '2'))).toBeNull();
    expect(readOwnedModelReceipt(encoded, token.replace(/b{64}/, 'c'.repeat(64)), id)).toBeNull();
    for (const value of [undefined, 'upstream-completion-id', encoded + 'x', encoded.toUpperCase(), encoded.slice(0, -1) + (encoded.endsWith('a') ? 'b' : 'a'), 'x'.repeat(1025)])
      expect(readOwnedModelReceipt(value, token, id)).toBeNull();
  });
  it('refuses authenticated but noncanonical tuple spellings or extra data', () => {
    const encoded = encodeOwnedModelReceipt(token, success);
    const json = Buffer.from(encoded.split('.')[1]!, 'base64url').toString('utf8');
    for (const bytes of [' ' + json, json.replace('42,', '42.0,'), json.replace(/]$/, ',0]'), json.replace('0.001', '-1')])
      expect(readOwnedModelReceipt(retag(bytes), token, id)).toBeNull();
  });
  it('validates complete semantic evidence and rejects getters without evaluating them', () => {
    const bad = [{ ...success, extra: 'metadata' }, { ...success, evidence: { kind: 'usage', tokens: 0.5, usd: 0 } },
      { ...success, evidence: { kind: 'usage', tokens: 1, usd: Infinity } }, { ...success, evidence: { kind: 'usage', tokens: 1, usd: -1 } },
      { requestId: id, state: 'succeeded' }, { ...success, state: 'unknown' }];
    for (const receipt of bad) expect(() => encodeOwnedModelReceipt(token, receipt as OwnedModelAttemptReceipt)).toThrow('Invalid owned model receipt');
    let reads = 0; const hostile = { ...success }; Object.defineProperty(hostile, 'evidence', { enumerable: true, get() { reads++; throw new Error('secret'); } });
    expect(() => encodeOwnedModelReceipt(token, hostile)).toThrow('Invalid owned model receipt'); expect(reads).toBe(0);
  });
});
